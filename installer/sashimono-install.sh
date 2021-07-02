#!/bin/bash
# Sashimono agent installation script.
# This must be executed with root privileges.

sashimono_bin=/usr/bin/sashimono-agent
docker_bin=/usr/bin/sashimono-agent/dockerbin

cgrulesgend_service=sashi-cgrulesgend

echo "Installing Sashimono..."

# Create bin dirs first so it automatically checks for privileged access.
mkdir -p $sashimono_bin
[ "$?" == "1" ] && echo "Could not create '$sashimono_bin'. Make sure you are running as sudo." && exit 1
mkdir -p $docker_bin
[ "$?" == "1" ] && echo "Could not create '$docker_bin'. Make sure you are running as sudo." && exit 1

# Install curl if not exists (required to download installation artifacts).
if ! command -v curl &>/dev/null; then
    apt-get install -y curl
fi

# Install cucgroup-tools if not exists (required to setup resource control groups).
if ! command -v /usr/sbin/cgconfigparser &>/dev/null || ! command -v /usr/sbin/cgrulesengd &>/dev/null; then
    apt-get install -y cgroup-tools
fi

# Copy cgred.conf from examples if not exists to setup control groups.
if [ ! -f /etc/cgred.conf ]; then
    cp /usr/share/doc/cgroup-tools/examples/cgred.conf /etc/
fi

# Create new cgconfig.conf if not exists to setup control groups.
if [ ! -f /etc/cgconfig.conf ]; then
    : >/etc/cgconfig.conf
fi

# Create new cgrules.conf if not exists to setup control groups.
if [ ! -f /etc/cgrules.conf ]; then
    : >/etc/cgrules.conf
fi

function rollback() {
    echo "Rolling back sashimono installation."
    $(pwd)/sashimono-uninstall.sh $user
    rm -r $tmp
    echo "Rolled back the installation."
    exit 1
}


# Install Sashimono agent binaries into sashimono bin dir.
# TODO.

# Download docker packages into a tmp dir and extract into docker bin.
echo "Installing rootless docker packages into $docker_bin"
tmp=$(mktemp -d)
cd $tmp
curl https://download.docker.com/linux/static/stable/$(uname -m)/docker-20.10.7.tgz --output docker.tgz
curl https://download.docker.com/linux/static/stable/$(uname -m)/docker-rootless-extras-20.10.7.tgz --output rootless.tgz

cd $docker_bin
tar zxf $tmp/docker.tgz --strip-components=1
tar zxf $tmp/rootless.tgz --strip-components=1

# Check whether installation dir is still empty.
[ -z "$(ls -A $docker_bin 2>/dev/null)" ] && echo "Installation failed." && rollback

# Adding quota limitation capability
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
tmpgrub=$tmpgrub.tmp
cp /etc/default/grub $tmpgrub

function add_grub_line() {
    var="${1}"
    val="${2}"
    file="${3}"
    # Check whether exist.
    sed -n -r -e "/^${var}=/{ /${val}/{q100}; }" $file
    res=$?
    if [ $res == 0 ]; then # if not exist and success.
        sed -i -r -e "/^${var}=/{ /${val}/!{ s/\"\s*\$/ ${val}\"/ } }" $file
    elif [ $res != 0 ] && [ $res != 100 ]; then # if error.
        echo "Grub update failed." && rollback
    fi
    return $res
}

add_grub_line GRUB_CMDLINE_LINUX_DEFAULT cgroup_enable=memory $tmpgrub
changed1=$?

add_grub_line GRUB_CMDLINE_LINUX_DEFAULT swapaccount=1 $tmpgrub
changed2=$?

if [ $changed1 == 0 ] || [ $changed2 == 0 ]; then
    mv $tmpgrub /etc/default/grub
    rm -r $tmp
    update-grub >/dev/null 2>&1
    echo "Updated grub."
    echo "System needs to be rebooted before start the sashimono."
    echo "Reboot now|later?"
    read confirmation
    if [ "$confirmation" == "now" ]; then
        reboot
    fi
fi

rm -r $tmp
echo "Done."
exit 0
