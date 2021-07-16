#!/bin/bash
# Sashimono agent installation script.
# This must be executed with root privileges.

sashimono_bin=/usr/bin/sashimono-agent
docker_bin=/usr/bin/sashimono-agent/dockerbin
sashimono_data=/etc/sashimono
sashimono_service="sashimono-agent"
cgcreate_service="sashimono-cgcreate"
group="sashimonousers"
cgroupsuffix="-cg"
script_dir=$(dirname "$(realpath "$0")")

[ -d $sashimono_bin ] && [ -n "$(ls -A $sashimono_bin)" ] &&
    echo "Aborting installation. Previous Sashimono installation detected at $sashimono_bin" && exit 1

# Check cgroup rule config exists.
[ ! -f /etc/cgred.conf ] && echo "Cgroup is not configured. Make sure you've installed and configured cgroup-tools." && exit 1

# Create bin dirs first so it automatically checks for privileged access.
mkdir -p $sashimono_bin
[ "$?" == "1" ] && echo "Could not create '$sashimono_bin'. Make sure you are running as sudo." && exit 1
mkdir -p $docker_bin
[ "$?" == "1" ] && echo "Could not create '$docker_bin'. Make sure you are running as sudo." && exit 1
mkdir -p $sashimono_data
[ "$?" == "1" ] && echo "Could not create '$sashimono_data'. Make sure you are running as sudo." && exit 1

echo "Installing Sashimono..."

# Install curl if not exists (required to download installation artifacts).
if ! command -v curl &>/dev/null; then
    apt-get install -y curl
fi

# Install openssl if not exists (required by Sashimono agent to create contract tls certs).
if ! command -v openssl &>/dev/null; then
    apt-get install -y openssl
fi

# Blake3 
if [ ! -f /usr/local/lib/libblake3.so ]; then
    cp "$script_dir"/libblake3.so /usr/local/lib/
fi

# Libfuse
apt-get install -y fuse3

# Update linker library cache.
sudo ldconfig

function rollback() {
    echo "Rolling back sashimono installation."
    "$script_dir"/sashimono-uninstall.sh
    echo "Rolled back the installation."
    exit 1
}

# Install Sashimono agent binaries into sashimono bin dir.
cp "$script_dir"/{sagent,hpfs,hpws,user-cgcreate.sh,user-install.sh,user-uninstall.sh} $sashimono_bin
chmod -R +x $sashimono_bin

# Download and install rootless dockerd.
"$script_dir"/docker-install.sh $docker_bin

# Check whether docker installation dir is still empty.
[ -z "$(ls -A $docker_bin 2>/dev/null)" ] && echo "Rootless Docker installation failed." && rollback

# Setting up cgroup rules.
! groupadd $group && echo "Group creation failed." && rollback
! echo "@$group       cpu,memory              %u$cgroupsuffix" >>/etc/cgrules.conf && echo "Cgroup rule creation failed." && rollback

# Setup Sashimono data dir.
cp -r "$script_dir"/contract_template $sashimono_data
$sashimono_bin/sagent new $sashimono_data

# Install Sashimono Agent cgcreate service.
# This is a onshot service which runs only once.
echo "[Unit]
Description=Sashimono cgroup creation service.
After=network.target
[Service]
User=root
Group=root
Type=oneshot
ExecStart=$sashimono_bin/user-cgcreate.sh $sashimono_data
[Install]
WantedBy=multi-user.target" >/etc/systemd/system/$cgcreate_service.service

# Install Sashimono Agent systemd service.
# StartLimitIntervalSec=0 to make unlimited retries. RestartSec=5 is to keep 5 second gap between restarts.
echo "[Unit]
Description=Running and monitoring sashimono agent.
After=network.target
StartLimitIntervalSec=0
[Service]
User=root
Group=root
Type=simple
WorkingDirectory=$sashimono_bin
ExecStart=$sashimono_bin/sagent run $sashimono_data
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target" >/etc/systemd/system/$sashimono_service.service

systemctl daemon-reload
systemctl enable $cgcreate_service
systemctl start $cgcreate_service
systemctl enable $sashimono_service
systemctl start $sashimono_service
# Both of these services needed to be restarted if sa.cfg max instance resources are manually changed.

echo "Sashimono installed successfully."
echo "Please restart your cgroup rule generator service or reboot your server for changes to apply."
exit 0
