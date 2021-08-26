#!/bin/bash
# Sashimono agent installation script.
# This must be executed with root privileges.
# -q for non-interactive (quiet) mode (This will skip the installation of xrpl message board)

user_bin=/usr/bin
sashimono_bin=/usr/bin/sashimono-agent
docker_bin=/usr/bin/sashimono-agent/dockerbin
sashimono_data=/etc/sashimono
sashimono_service="sashimono-agent"
cgcreate_service="sashimono-cgcreate"
mb_xrpl_service="sashimono-mb-xrpl"
mb_xrpl_dir="$sashimono_bin"/mb-xrpl
mb_xrpl_conf="$mb_xrpl_dir"/mb-xrpl.cfg
hook_xrpl_addr="rb4H5w7H1QA2qKjHCRSuUey2fnMBGbN2c"
group="sashimonousers"
admin_group="sashiadmin"
cgroupsuffix="-cg"
registryuser="sashidockerreg"
registryport=4444
script_dir=$(dirname "$(realpath "$0")")

xrpl_server_url="wss://hooks-testnet.xrpl-labs.com"
xrpl_fauset_url="https://hooks-testnet.xrpl-labs.com/newcreds"

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
    "$script_dir"/sashimono-uninstall.sh -q # Quiet uninstall.
    echo "Rolled back the installation."
    exit 1
}

# Install Sashimono agent binaries into sashimono bin dir.
cp "$script_dir"/{sagent,hpfs,user-cgcreate.sh,user-install.sh,user-uninstall.sh} $sashimono_bin
chmod -R +x $sashimono_bin

# Install Sashimono CLI binaries into user bin dir.
cp "$script_dir"/sashi $user_bin

# Download and install rootless dockerd.
"$script_dir"/docker-install.sh $docker_bin

# Check whether docker installation dir is still empty.
[ -z "$(ls -A $docker_bin 2>/dev/null)" ] && echo "Rootless Docker installation failed." && rollback

# This will be commented and self ip will be hardcoded since the interface differs from machine to machine.
# This needs to be fixed later.
# selfip=$(ip -4 a l ens3 | awk '/inet/ {print $2}' | cut -d/ -f1)
selfip="127.0.0.1"

# Install private docker registry.
# (Disabled until secure registry configuration)
# ./registry-install.sh $docker_bin $registryuser $registryport
# [ "$?" == "1" ] && rollback
# registry_addr=$selfip:$registryport

# Setting up cgroup rules.
! groupadd $group && echo "Group creation failed." && rollback
! echo "@$group       cpu,memory              %u$cgroupsuffix" >>/etc/cgrules.conf && echo "Cgroup rule creation failed." && rollback

# Setting up Sashimono admin group.
! groupadd $admin_group && echo "Admin group creation failed." && rollback

# Setup Sashimono data dir.
cp -r "$script_dir"/contract_template $sashimono_data
$sashimono_bin/sagent new $sashimono_data $selfip $registry_addr

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

if [ "$quiet" != "-q" ]; then
    # Setup xrpl message board.
    cp -r "$script_dir"/mb-xrpl $sashimono_bin
    chmod -R +x "$sashimono_bin"/mb-xrpl

    echo "Please answer following questions to setup xrpl message board.."
    # Ask for input until a correct value is given
    while [[ ! "$instance_size" =~ [0-9]+ ]]; do
        read -p "Instance size (kb)? " instance_size </dev/tty
        [[ ! "$instance_size" =~ [0-9]+ ]] && echo "Instance size should be a number."
    done
    while [ -z "$location" ] || [[ "$location" =~ .*\;.* ]]; do
        read -p "Location? " location </dev/tty
        ([ -z "$location" ] && echo "Location cannot be empty.") || ([[ "$location" =~ .*\;.* ]] && echo "Location cannot include ';'.")
    done
    while [[ ! "$token" =~ ^[A-Z]{3}$ ]]; do
        read -p "Token name? " token </dev/tty
        [[ ! "$token" =~ ^[A-Z]{3}$ ]] && echo "Token name should be 3 UPPERCASE letters."
    done

    # Generate new fauset account.
    new_acc=$(curl -X POST $xrpl_fauset_url)
    # If result is not a json, account generation failed.
    [[ ! "$new_acc" =~ \{.+\} ]] && echo "Xrpl fauset account generation failed." && rollback

    address=$(echo $new_acc | jq -r '.address')
    secret=$(echo $new_acc | jq -r '.secret')
    ([ "$address" == "" ] || [ "$address" == "null" ] ||
        [ "$secret" == "" ] || [ "$secret" == "null" ]) && echo "Invalid xrpl account details: $new_acc" && rollback

    (! echo "{\"host\":{\"name\":\"\",\"location\":\"$location\",\"instanceSize\":\"$instance_size\"},\"xrpl\":{\"address\":\"$address\",\"secret\":\"$secret\",\"token\":\"$token\",\"hookAddress\":\"$hook_xrpl_addr\",\"regTrustHash\":\"\",\"regFeeHash\":\"\"}}" | jq . >$mb_xrpl_conf) && rollback

    # Install xrpl message board systemd service.
    # StartLimitIntervalSec=0 to make unlimited retries. RestartSec=5 is to keep 5 second gap between restarts.
    echo "[Unit]
    Description=Running and monitoring evernode xrpl transactions.
    After=network.target
    StartLimitIntervalSec=0
    [Service]
    User=root
    Group=root
    Type=simple
    WorkingDirectory=$mb_xrpl_dir
    ExecStart=node $mb_xrpl_dir $xrpl_server_url
    Restart=on-failure
    RestartSec=5
    [Install]
    WantedBy=multi-user.target" >/etc/systemd/system/$mb_xrpl_service.service

    # This service needed to be restarted when mb-xrpl.cfg is changed.
    systemctl enable $mb_xrpl_service
    systemctl start $mb_xrpl_service
fi

echo "Sashimono installed successfully."
echo "Please restart your cgroup rule generator service or reboot your server for changes to apply."
exit 0
