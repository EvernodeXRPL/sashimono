#!/bin/bash
# Sashimono agent installation script.
# This must be executed with root privileges.

sashimono_bin=/usr/bin/sashimono-agent
docker_bin=/usr/bin/sashimono-agent/dockerbin
sashimono_data=/etc/sashimono
sashimono_service="sashimono-agent"
group="sashimonousers"
cgroupsuffix="-cg"
script_dir=$(pwd)

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

# Install openssl if not exists (required by Sashimono agent to create contract tls certs).
if ! command -v openssl &>/dev/null; then
    apt-get install -y openssl
fi

# Install Sashimono agent binaries into sashimono bin dir.
cp $script_dir/{sagent,hpfs,hpws,user-install.sh,user-uninstall.sh} $sashimono_bin
chmod -R +x $sashimono_bin

# Download docker packages into a tmp dir and extract into docker bin.
echo "Installing rootless docker packages into $docker_bin"

tmp=$(mktemp -d)
function rollback() {
    echo "Rolling back sashimono installation."
    $script_dir/sashimono-uninstall.sh
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

# Check whether docker installation dir is still empty.
[ -z "$(ls -A $docker_bin 2>/dev/null)" ] && echo "Rootless Docker installation failed." && rollback

# Setting up cgroup rules.
! groupadd $group && echo "Group creation failed." && rollback
! echo "@$group       cpu,memory              %u$cgroupsuffix" >>/etc/cgrules.conf && echo "Cgroup rule creation failed." && rollback

# StartLimitIntervalSec=0 to make unlimited retries. RestartSec=1 is to keep 1 second gap between restarts.
if [ -f $sashimono_bin/sagent ]; then
    echo "[Unit]
    Description=Running and monitoring sashimono agent.
    After=network.target
    StartLimitIntervalSec=0
    [Service]
    User=root
    Group=root
    Type=simple
    ExecStart=$sashimono_bin/sagent run $sashimono_data
    Restart=on-failure
    RestartSec=1
    [Install]
    WantedBy=multi-user.target" >/etc/systemd/system/$sashimono_service.service

    systemctl daemon-reload
    systemctl enable $sashimono_service
    systemctl start $sashimono_service
else
    echo "Sashimono binary not found in ${sashimono_bin}. Skipped adding Sashimono service."
fi

# Setup Sashimono data dir.
cp -r $script_dir/contract_template $sashimono_data
$sashimono_bin/sagent new $sashimono_data

echo "Sashimono installed successfully."
echo "Please restart your cgroup rule generator service or reboot your server for changes to apply."
exit 0
