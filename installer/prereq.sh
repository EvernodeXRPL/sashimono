#!/bin/bash
# Sashimono Ubuntu prerequisites installation script.
# This must be executed with root privileges.

# Adding user disk quota limitation capability
# Enable user quota in fstab for root mount.
# Enable cgroup memory and swapaccount capability.
# Setup cgroups rules engine service.

echo "---Sashimono prerequisites installer---"

[ -z "$1" ] && echo "cgrules engine service name not specified." && exit 1

tmp=$(mktemp -d)
tmpfstab=$tmp.tmp
originalfstab=/etc/fstab
cp $originalfstab "$tmpfstab"
backup=$originalfstab.sashi.bk
cgrulesengd_service=$1 # cgroups rules engine service name

apt-get update

# Install nodejs 14 if not exists.
if ! command -v node &>/dev/null; then
    apt-get -y install ca-certificates # In case nodejs package certitficates are renewed.
    curl -sL https://deb.nodesource.com/setup_14.x | bash -
    apt-get -y install nodejs
else
    version=$(node -v)
    if [[ ! $version =~ v14\..* ]]; then
        echo "Found node $version, recommended node v14.x.x"
    fi
fi

apt-get install -y uidmap

# Install slirp4netns if not exists (required for high performance rootless networking).
if [ ! command -v slirp4netns &>/dev/null ]; then
    apt-get install -y slirp4netns
fi

# Install curl if not exists (required to download installation artifacts).
if [ ! command -v curl &>/dev/null ]; then
    apt-get install -y curl
fi

# Install openssl if not exists (required by Sashimono agent to create contract tls certs).
if [ ! command -v openssl &>/dev/null ]; then
    apt-get install -y openssl
fi

# Blake3
if [ ! -f /usr/local/lib/libblake3.so ]; then
    cp "$script_dir"/libblake3.so /usr/local/lib/
fi

# jq command is used for json manipulation.
if [ ! command -v jq &>/dev/null ]; then
    apt-get install -y jq
fi

# Libfuse
apt-get install -y fuse3

# Update linker library cache.
sudo ldconfig

# -------------------------------
# fstab changes
# We do not edit original file, instead we create a temp file with original and edit it.
# Replace temp file with original only if success.

# Check for pattern <Not starting with a comment><Not whitespace(Device)><Whitespace></><Whitespace><Not whitespace(FS type)><Whitespace><No whitespace(Options)><Whitespace><Number(Dump)><Whitespace><Number(Pass)>
# And whether Options is <Not whitespace>*grpjquota=aquota.group or jqfmt=vfsv0<Not whitespace>*
# If not add groupquota to the options.
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
    if ! mount -o remount / 2>&1 ; then
        mv $backup $originalfstab
        echo "Re mounting error." && exit 1
    fi 
    echo "Updated fstab."
else
    echo "fstab already configured."
fi

# Check and turn on group quota if not enabled.
if [ ! -f /aquota.group ]; then
    # quota package is not installed.
    if ! command -v quota &>/dev/null; then
        apt-get install -y quota
    fi
    quotacheck -ugm /
    quotaon -v /
fi

# -------------------------------

# Check fuse config exists.
[ ! -f /etc/fuse.conf ] && echo "Fuse config does not exist, Make sure you've installed fuse."

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
        echo "user_allow_other" >> "$tmpconf"
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

# Install cgroup-tools if not exists (required to setup resource control groups).
if ! command -v /usr/sbin/cgconfigparser >/dev/null || ! command -v /usr/sbin/cgrulesengd >/dev/null; then
    apt-get install -y cgroup-tools
fi

# Copy cgred.conf from examples if not exists to setup control groups.
[ ! -f /etc/cgred.conf ] && cp /usr/share/doc/cgroup-tools/examples/cgred.conf /etc/

# Create new cgconfig.conf if not exists to setup control groups.
[ ! -f /etc/cgconfig.conf ] && : >/etc/cgconfig.conf

# Create new cgrules.conf if not exists to setup control groups.
[ ! -f /etc/cgrules.conf ] && : >/etc/cgrules.conf

# Setup a service if not exists to run cgroup rules generator.
cgrulesengd_file="/etc/systemd/system/$cgrulesengd_service.service"
if ! [ -f "$cgrulesengd_file" ];
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

# Enable cgroup memory and swapaccount if not already configured
# We create a temp of the grub file and replace with original file only if success.
tmp=$(mktemp -d)
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

    # If there's no error.
    if [ $res -eq 0 ] || [ $res -eq 100 ]; then
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
    fi
elif [ $res -eq 0 ]; then
    echo "GRUB_CMDLINE_LINUX_DEFAULT=\"cgroup_enable=memory swapaccount=1\"" >> "$tmpgrub"
    res=$?
    updated=1
fi

# If the res is not success(0) or alredy exist(100).
[ ! $res -eq 0 ] && [ ! $res -eq 100 ] && echo "Grub GRUB_CMDLINE_LINUX_DEFAULT update failed." && exit 1

# If updated we do update-grub and reboot.
if [ $updated -eq 1 ]; then
    # Create a backup of original grub, So we can replace the backup with original if update-grub failed.
    grub_backup=/etc/default/grub.sashi.bk
    cp /etc/default/grub $grub_backup
    mv "$tmpgrub" /etc/default/grub
    rm -r "$tmp"
    if ! update-grub >/dev/null 2>&1 ; then
        mv $grub_backup /etc/default/grub
        echo "Grub update failed."
        exit 1
    fi 
    echo "Updated grub. System needs to be rebooted to apply grub changes."
else
    rm -r "$tmp"
    echo "Grub already configured."
fi

exit 0