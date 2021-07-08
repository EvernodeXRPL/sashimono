#!/bin/bash
# Sashimono agent installation script.
# This must be executed with root privileges.

sashimono_bin=/usr/bin/sashimono-agent
docker_bin=/usr/bin/sashimono-agent/dockerbin
sashimono_data=/etc/sashimono
group="sashimono"

echo "Installing Sashimono..."

# Check cgroup rule config exists.
[ ! -f /etc/cgred.conf ] && echo "Cgroup is not configured. Make sure you've installed and configured cgroup-tools." && exit 1

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

rm -r $tmp

# Check whether installation dir is still empty.
[ -z "$(ls -A $docker_bin 2>/dev/null)" ] && echo "Installation failed." && exit 1

# Setting up cgroup rules.
! groupadd $group && echo "Group creation failed." && rollback
! echo "@$group       cpu,memory              %u$group" >> /etc/cgrules.conf && echo "Cgroup rule creation failed." && rollback

echo "Sashimono installed successfully."
echo "Please restart your cgroup rule generator service or reboot your server for changes to apply."
exit 0
