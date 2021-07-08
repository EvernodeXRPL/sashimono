#!/bin/bash
# Sashimono agent installation script.
# This must be executed with root privileges.

sashimono_bin=/usr/bin/sashimono-agent
docker_bin=/usr/bin/sashimono-agent/dockerbin
sashimono_data=/etc/sashimono

cgrulesgend_service=sashi-cgrulesgend

echo "Installing Sashimono..."

# Create bin dirs first so it automatically checks for privileged access.
mkdir -p $sashimono_bin
[ "$?" == "1" ] && echo "Could not create '$sashimono_bin'. Make sure you are running as sudo." && exit 1
mkdir -p $docker_bin
[ "$?" == "1" ] && echo "Could not create '$docker_bin'. Make sure you are running as sudo." && exit 1
mkdir -p $sashimono_data
[ "$?" == "1" ] && echo "Could not create '$sashimono_data'. Make sure you are running as sudo." && exit 1

# Install curl if not exists (required to download installation artifacts).
if ! command -v curl &>/dev/null; then
    apt-get install -y curl
fi

# Install cgroup-tools if not exists (required to setup resource control groups).
if ! command -v /usr/sbin/cgconfigparser &>/dev/null || ! command -v /usr/sbin/cgrulesengd &>/dev/null; then
    apt-get install -y cgroup-tools
fi

# Copy cgred.conf from examples if not exists to setup control groups.
[ ! -f /etc/cgred.conf ] && cp /usr/share/doc/cgroup-tools/examples/cgred.conf /etc/

# Create new cgconfig.conf if not exists to setup control groups.
[ ! -f /etc/cgconfig.conf ] && : >/etc/cgconfig.conf

# Create new cgrules.conf if not exists to setup control groups.
[ ! -f /etc/cgrules.conf ] && : >/etc/cgrules.conf

# Install Sashimono agent binaries into sashimono bin dir.
# TODO.

# Copy necessary files into sashimono data folder.
cp -r ../dependencies/default_contract $sashimono_data
if ! cp ../bootstrap-contract/script.sh $sashimono_data/default_contract/contract_fs/seed/state/script.sh; then
    echo "script.sh file not found."
    exit 1
fi

if ! cp ../build/bootstrap_contract $sashimono_data/default_contract/contract_fs/seed/state/bootstrap_contract; then
    echo "bootstrap_contract file not found." 
    exit 1
fi

# Download docker packages into a tmp dir and extract into docker bin.
echo "Installing rootless docker packages into $docker_bin"

installer_dir=$(pwd)
tmp=$(mktemp -d)
function rollback() {
    echo "Rolling back sashimono installation."
    $installer_dir/sashimono-uninstall.sh
    [ -d $tmp ] && rm -r $tmp
    echo "Rolled back the installation."
    exit 1
}

cd $tmp
curl https://download.docker.com/linux/static/stable/$(uname -m)/docker-20.10.7.tgz --output docker.tgz
curl https://download.docker.com/linux/static/stable/$(uname -m)/docker-rootless-extras-20.10.7.tgz --output rootless.tgz

cd $docker_bin
tar zxf $tmp/docker.tgz --strip-components=1
tar zxf $tmp/rootless.tgz --strip-components=1

# Check whether installation dir is still empty.
[ -z "$(ls -A $docker_bin 2>/dev/null)" ] && echo "Installation failed." && rollback

# Adding quota limitation capability
# Enable user quota in fstab for root mount.
tmpfstab=$tmp.tmp
originalfstab=/etc/fstab
cp $originalfstab "$tmpfstab"
backup=$originalfstab.sashi.bk

updated=0
sed -n -r -e "/^[^#]\S+\s+\/\s+\S+\s+\S+\s+[0-9]+\s+[0-9]+\s*/{ /^\S+\s+\/\s+\S+\s+\S*usrquota\S*/{q100} }" "$tmpfstab"
res=$?
if [ $res -eq 0 ]; then
    sed -i -r -e "/^[^#]\S+\s+\/\s+\S+\s+\S+\s+[0-9]+\s+[0-9]+\s*/{ s/^\S+\s+\/\s+\S+\s+\S+/&,usrquota/ }" "$tmpfstab"
    res=$?
    updated=1
fi

[ ! $res -eq 0 ] && [ ! $res -eq 100 ] && echo "fstab update failed." && rollback

if [ $updated -eq 1 ]; then
    cp $originalfstab $backup
    mv "$tmpfstab" $originalfstab
    if ! mount -o remount / 2>&1 ; then
        mv $backup $originalfstab
        echo "Re mounting error." && rollback
    fi 
    echo "Updated fstab."
else
    echo "fstab already configured."
fi
# Check and turn on user quota if not enabled.
if [ ! -f /aquota.user ]; then
    # quota package is not installed.
    if ! command -v quota &>/dev/null; then
        apt-get install -y quota >/dev/null 2>&1
    fi
    sudo quotacheck -ugm /
    sudo quotaon -v /
fi

# Setup resources limitation dependencies.

echo "[Unit]
Description=cgroup rules generator
After=network.target

[Service]
User=root
Group=root
Type=forking
EnvironmentFile=-/etc/cgred.conf
ExecStart=/usr/sbin/cgrulesengd
Restart=on-failure

[Install]
WantedBy=multi-user.target" >/etc/systemd/system/$cgrulesgend_service.service

echo "Configured $cgrulesgend_service service."

# Enable cgroup memory and swapaccount if not already configured
# We create a temp of the grub file and replace with original file only if success.
tmpgrub=$tmp.tmp
cp /etc/default/grub "$tmpgrub"

updated=0
# Check GRUB_CMDLINE_LINUX_DEFAULT exists, create new if not exists.
# If exists check for cgroup_enable=memory and swapaccount=1 and configure them if not already configured.
sed -n -r -e "/^GRUB_CMDLINE_LINUX_DEFAULT=/{q100}" "$tmpgrub"
res=$?
if [ $res -eq 100 ]; then
    # Check cgroup_enable=memory exists, create new if not exists otherwise skip.
    sed -n -r -e "/^GRUB_CMDLINE_LINUX_DEFAULT=/{ /cgroup_enable=memory/{q100}; }" "$tmpgrub"
    res=$?
    if [ $res -eq 0 ]; then
        sed -i -r -e "/^GRUB_CMDLINE_LINUX_DEFAULT=/{ s/\"\s*\$/ cgroup_enable=memory\"/ }" "$tmpgrub"
        res=$?
        updated=1
    fi

    # Check swapaccount=1 exists, create new if not exists otherwise skip.
    sed -n -r -e "/^GRUB_CMDLINE_LINUX_DEFAULT=/{ /swapaccount=1/{q100}; }" "$tmpgrub"
    res=$?
    if [ $res -eq 0 ]; then
        # Check whether there's swapaccount value other that 1, If so replace value with 1.
        # Otherwise add swapaccount=1 after cgroup_enable=memory.
        sed -n -r -e "/^GRUB_CMDLINE_LINUX_DEFAULT=/{ /swapaccount=/{q100}; }" "$tmpgrub"
        res=$?
        if [ $res -eq 100 ]; then
            sed -i -r -e "/^GRUB_CMDLINE_LINUX_DEFAULT=/{ s/swapaccount=[0-9]*/swapaccount=1/ }" "$tmpgrub"
            res=$?
            updated=1
        elif [ $res -eq 0 ]; then
            sed -i -r -e "/^GRUB_CMDLINE_LINUX_DEFAULT=/{ s/cgroup_enable=memory/cgroup_enable=memory swapaccount=1/ }" "$tmpgrub"
            res=$?
            updated=1
        fi
    fi
elif [ $res -eq 0 ]; then
    echo "GRUB_CMDLINE_LINUX_DEFAULT=\"cgroup_enable=memory swapaccount=1\"" >> "$tmpgrub"
    res=$?
    updated=1
fi

[ ! $res -eq 0 ] && [ ! $res -eq 100 ] && echo "Grub GRUB_CMDLINE_LINUX_DEFAULT update failed." && rollback

if [ $updated -eq 1 ]; then
    # Create a backup of original grub, So we can replace the backup with original if update-grub failed.
    grub_backup=/etc/default/grub.sashi.bk
    cp /etc/default/grub $grub_backup
    mv "$tmpgrub" /etc/default/grub
    rm -r "$tmp"
    if ! update-grub >/dev/null 2>&1 ; then
        mv $grub_backup /etc/default/grub
        echo "Grub update failed."
        rollback
    fi 
    echo "Updated grub."
    echo "System needs to be rebooted before starting Sashimono."
    echo "Reboot now|later?"
    read confirmation
    if [ "$confirmation" = "now" ]; then
        reboot
    fi
else
    rm -r "$tmp"
    echo "Grub already configured."
fi

echo "Done."
exit 0
