#!/bin/bash
# Sashimono Ubuntu prerequisites installation script.
# This must be executed with root privileges.

# Adding user disk quota limitation capability
# Enable user quota in fstab for root mount.
# Enable cgroup memory and swapaccount capability.
# Setup cgroups rules engine service.

echo "---Sashimono prerequisites installer---"

tmp=$(mktemp -d)
tmpfstab=$tmp.tmp
originalfstab=/etc/fstab
cp $originalfstab "$tmpfstab"
backup=$originalfstab.sashi.bk
cgrulesengd_service=$1 # cgroups rules engine service name

[ -z "$cgrulesengd_service" ] && cgrulesengd_service="cgrulesengd"

function stage() {
    echo "STAGE $1" # This is picked up by the setup console output filter.
}

stage "Installing dependencies"

# Added --allow-releaseinfo-change
# To fix - Repository 'https://apprepo.vultr.com/ubuntu universal InRelease' changed its 'Codename' value from 'buster' to 'universal'
apt-get update --allow-releaseinfo-change
apt-get install -y uidmap fuse3 cgroup-tools quota curl openssl jq

# uidmap        # Required for rootless docker.
# slirp4netns   # Required for high performance rootless networking.
# fuse3         # Required for hpfs.
# cgroup-tools  # Required to setup contract instances resource limits.
# quota         # Required for disk space group quota.
# curl          # Required to download installation artifacts.
# openssl       # Required by Sashimono agent to create contract tls certs.
# jq            # Used for json config file manipulation.
# qrencode      # Used for QR code generating.

# Install nodejs if not exists.
if ! command -v node &>/dev/null; then
    stage "Installing nodejs"
    apt-get -y install ca-certificates # In case nodejs package certitficates are renewed.
    curl -sL https://deb.nodesource.com/setup_16.x | bash -
    apt-get -y install nodejs
else
    version=$(node -v | cut -d '.' -f1)
    version=${version:1}
    if [[ $version -lt 16 ]]; then
        echo "Found node $version, recommended node v16.x.x or later"
    fi
fi

# Install iptables
if ! command -v iptables &>/dev/null; then
    stage "Installing iptables"
    apt-get install -y iptables
fi

# Load br_netfilter kernel module on startup (if not loaded already).
if [[ -z "$(lsmod | grep br_netfilter)" ]]; then
    echo "Adding br_netfilter"
    modprobe br_netfilter
    echo "br_netfilter" >/etc/modules-load.d/br_netfilter.conf
fi

# Install ufw
if ! command -v ufw &>/dev/null; then
    stage "Installing ufw"
    apt-get install -y ufw
fi

# Install snap (required for letsencrypt certbot install)
if ! command -v snap &>/dev/null; then
    stage "Installing snapd"
    apt-get install -y snapd
fi

# -------------------------------
# fstab changes
# We do not edit original file, instead we create a temp file with original and edit it.
# Replace temp file with original only if success.

# Check for pattern <Not starting with a comment><Not whitespace(Device)><Whitespace></><Whitespace><Not whitespace(FS type)><Whitespace><No whitespace(Options)><Whitespace><Number(Dump)><Whitespace><Number(Pass)>
# And whether Options is <Not whitespace>*grpjquota=aquota.group or jqfmt=vfsv0<Not whitespace>*
# If not add groupquota to the options.
stage "Configuring fstab"
updated=0
sed -n -r -e "/^[^#]\S+\s+\/\s+\S+\s+\S+\s+[0-9]+\s+[0-9]+\s*/{ /^\S+\s+\/\s+\S+\s+\S*grpjquota=aquota.group\S*/{q100} }" "$tmpfstab"
res=$?
if [ $res -eq 0 ]; then
    sed -i -r -e "/^[^#]\S+\s+\/\s+\S+\s+\S+\s+[0-9]+\s+[0-9]+\s*/{ s/^\S+\s+\/\s+\S+\s+\S+/&,grpjquota=aquota.group/ }" "$tmpfstab"
    res=$?
    updated=1
fi

# If the res is not success(0) or already exist(100).
[ ! $res -eq 0 ] && [ ! $res -eq 100 ] && echo "fstab update failed." && exit 1

sed -n -r -e "/^[^#]\S+\s+\/\s+\S+\s+\S+\s+[0-9]+\s+[0-9]+\s*/{ /^\S+\s+\/\s+\S+\s+\S*jqfmt=vfsv0\S*/{q100} }" "$tmpfstab"
res=$?
if [ $res -eq 0 ]; then
    sed -i -r -e "/^[^#]\S+\s+\/\s+\S+\s+\S+\s+[0-9]+\s+[0-9]+\s*/{ s/^\S+\s+\/\s+\S+\s+\S+/&,jqfmt=vfsv0/ }" "$tmpfstab"
    res=$?
    updated=1
fi

# If the res is not success(0) or alredy exist(100).
[ ! $res -eq 0 ] && [ ! $res -eq 100 ] && echo "fstab update failed." && exit 1

# If updated we do remount.
if [ $updated -eq 1 ]; then
    # Create a backup of original, if remount failed replace updated with backup.
    cp $originalfstab $backup
    mv "$tmpfstab" $originalfstab
    if ! mount -o remount / 2>&1; then
        mv $backup $originalfstab
        echo "Re mounting error." && exit 1
    fi
    echo "Updated fstab."
else
    echo "fstab already configured."
fi

# Check and turn on group quota if not enabled.
if [ ! -f /aquota.group ]; then
    quotacheck -ugm /
    quotaon -v /
fi

# -------------------------------
stage "Configuring fuse"

# Check fuse config exists.
[ ! -f /etc/fuse.conf ] && echo "Fuse config does not exist, Make sure you've installed fuse." && exit 1

# Set user_allow_other if not already configured
# We create a temp of the config file and replace with original file only if success.
tmp=$(mktemp -d)
tmpconf=$tmp.tmp
cp /etc/fuse.conf "$tmpconf"

updated=0
# Check user_allow_other exists, create new if not exists.
# If exists do nothing otherwise set value.
sed -n -r -e "/^user_allow_other\s*\$/{q100}" "$tmpconf"
res=$?
if [ $res -eq 0 ]; then
    # Check user_allow_other commented, create new if not commented otherwise uncomment.
    # Add as new line if not exist.
    sed -n -r -e "/^#\s*user_allow_other\s*\$/{q100}" "$tmpconf"
    res=$?
    if [ $res -eq 100 ]; then
        sed -i -r -e "s/^#\s*user_allow_other\s*\$/user_allow_other/" "$tmpconf"
        res=$?
        updated=1
    elif [ $res -eq 0 ]; then
        echo "user_allow_other" >>"$tmpconf"
        res=$?
        updated=1
    fi
fi

# If the res is not success(0) or alredy exist(100).
[ ! $res -eq 0 ] && [ ! $res -eq 100 ] && echo "Fuse config update failed." && exit 1

# If updated we do replacing.
if [ $updated -eq 1 ]; then
    # Create a backup of original config.
    conf_backup=/etc/fuse.conf.sashi.bk
    cp /etc/fuse.conf $conf_backup
    mv "$tmpconf" /etc/fuse.conf
    rm -r "$tmp"
    echo "Updated fuse config."
else
    rm -r "$tmp"
    echo "Fuse config already updated."
fi

# -------------------------------
stage "Configuring cgroup rules engine"

# Copy cgred.conf from examples if not exists to setup control groups.
[ ! -f /etc/cgred.conf ] && cp /usr/share/doc/cgroup-tools/examples/cgred.conf /etc/

# Create new cgconfig.conf if not exists to setup control groups.
[ ! -f /etc/cgconfig.conf ] && : >/etc/cgconfig.conf

# Create new cgrules.conf if not exists to setup control groups.
[ ! -f /etc/cgrules.conf ] && : >/etc/cgrules.conf

# Setup a service if not exists to run cgroup rules generator.
cgrulesengd_file="/etc/systemd/system/$cgrulesengd_service.service"
if ! [ -f "$cgrulesengd_file" ]; then
    echo "[Unit]
    Description=cgroups rules generator
    After=network.target

    [Service]
    User=root
    Group=root
    Type=forking
    EnvironmentFile=-/etc/cgred.conf
    ExecStart=/usr/sbin/cgrulesengd
    Restart=on-failure

    [Install]
    WantedBy=multi-user.target" >$cgrulesengd_file
    systemctl daemon-reload
fi
systemctl enable $cgrulesengd_service
systemctl start $cgrulesengd_service

# -------------------------------
stage "Configuring grub"

# Enable cgroup memory and swapaccount if not already configured
# We create a temp of the grub file and replace with original file only if success.
tmp=$(mktemp -d)
tmpgrub=$tmp.tmp
cp /etc/default/grub "$tmpgrub"

updated=0
# Check GRUB_CMDLINE_LINUX exists, create new if not exists.
# If exists check for cgroup_enable=memory and swapaccount=1 and configure them if not already configured.
sed -n -r -e "/^GRUB_CMDLINE_LINUX=/{q100}" "$tmpgrub"
res=$?
if [ $res -eq 100 ]; then
    # Check cgroup_enable=memory exists, create new if not exists otherwise skip.
    sed -n -r -e "/^GRUB_CMDLINE_LINUX=/{ /cgroup_enable=memory/{q100}; }" "$tmpgrub"
    res=$?
    if [ $res -eq 0 ]; then
        sed -i -r -e "/^GRUB_CMDLINE_LINUX=/{ s/\"\s*\$/ cgroup_enable=memory\"/ }" "$tmpgrub"
        res=$?
        updated=1
    fi

    # If there's no error.
    if [ $res -eq 0 ] || [ $res -eq 100 ]; then
        # Check swapaccount=1 exists, create new if not exists otherwise skip.
        sed -n -r -e "/^GRUB_CMDLINE_LINUX=/{ /swapaccount=1/{q100}; }" "$tmpgrub"
        res=$?
        if [ $res -eq 0 ]; then
            # Check whether there's swapaccount value other than 1, If so replace value with 1.
            # Otherwise add swapaccount=1 after cgroup_enable=memory.
            sed -n -r -e "/^GRUB_CMDLINE_LINUX=/{ /swapaccount=/{q100}; }" "$tmpgrub"
            res=$?
            if [ $res -eq 100 ]; then
                sed -i -r -e "/^GRUB_CMDLINE_LINUX=/{ s/swapaccount=[0-9]*/swapaccount=1/ }" "$tmpgrub"
                res=$?
                updated=1
            elif [ $res -eq 0 ]; then
                sed -i -r -e "/^GRUB_CMDLINE_LINUX=/{ s/cgroup_enable=memory/cgroup_enable=memory swapaccount=1/ }" "$tmpgrub"
                res=$?
                updated=1
            fi
        fi
    fi
elif [ $res -eq 0 ]; then
    echo "GRUB_CMDLINE_LINUX=\"cgroup_enable=memory swapaccount=1\"" >>"$tmpgrub"
    res=$?
    updated=1
fi

# If the res is not success(0) or alredy exist(100).
[ ! $res -eq 0 ] && [ ! $res -eq 100 ] && echo "Grub GRUB_CMDLINE_LINUX update failed." && exit 1

# If updated we do update-grub and reboot.
if [ $updated -eq 1 ]; then
    # Create a backup of original grub, So we can replace the backup with original if update-grub failed.
    grub_backup=/etc/default/grub.sashi.bk
    cp /etc/default/grub $grub_backup
    mv "$tmpgrub" /etc/default/grub
    rm -r "$tmp"
    if ! update-grub >/dev/null 2>&1; then
        mv $grub_backup /etc/default/grub
        echo "Grub update failed."
        exit 1
    fi

    # Indicate pending reboot in the standard reboot required file.
    touch /run/reboot-required
    rebootpkgs=/run/reboot-required.pkgs
    (! [ -f $rebootpkgs ] || [ -z "$(grep sashimono $rebootpkgs)" ]) && echo "sashimono" >>$rebootpkgs

    echo "Updated grub. System needs to be rebooted to apply grub changes."
else
    rm -r "$tmp"
    echo "Grub already configured."
fi

exit 0
