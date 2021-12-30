#!/bin/bash
# Sashimono agent installation script.
# This must be executed with root privileges.

echo "---Sashimono installer---"

inetaddr=$1
countrycode=$2
inst_count=$3
cpuMicroSec=$4
ramKB=$5
swapKB=$6
diskKB=$7
description=$8

script_dir=$(dirname "$(realpath "$0")")

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

function rollback() {
    echo "Rolling back sashimono installation."
    "$script_dir"/sashimono-uninstall.sh
    echo "Rolled back the installation."
    exit 1
}

# Install Sashimono agent binaries into sashimono bin dir.
cp "$script_dir"/{sagent,hpfs,user-cgcreate.sh,user-install.sh,user-uninstall.sh} $sashimono_bin
chmod -R +x $sashimono_bin

# Blake3
[ ! -f /usr/local/lib/libblake3.so ] && cp "$script_dir"/libblake3.so /usr/local/lib/
# Update linker library cache.
ldconfig

# Install Sashimono CLI binaries into user bin dir.
cp "$script_dir"/sashi $user_bin

# Download and install rootless dockerd.
"$script_dir"/docker-install.sh $docker_bin

# Check whether docker installation dir is still empty.
[ -z "$(ls -A $docker_bin 2>/dev/null)" ] && echo "Rootless Docker installation failed." && rollback

# Install private docker registry.
# (Disabled until secure registry configuration)
# ./registry-install.sh $docker_bin $registryuser $registryport
# [ "$?" == "1" ] && rollback
# registry_addr=$inetaddr:$registryport

# Setting up Sashimono admin group.
! groupadd $admin_group && echo "Admin group creation failed." && rollback

# Setup Sashimono data dir.
cp -r "$script_dir"/contract_template $sashimono_data

# Find the cgroups rules engine service.
cgrulesengd_filename=$(basename $(grep "ExecStart.*=.*/cgrulesengd$" /etc/systemd/system/*.service | head -1 | awk -F : ' { print $1 } '))
cgrulesengd_service="${cgrulesengd_filename%.*}"
[ -z "$cgrulesengd_service" ] && echo "cgroups rules engine service does not exist." && rollback

# Setting up cgroup rules.
echo "Creating cgroup rules..."
! groupadd $group && echo "Group creation failed." && rollback
! echo "@$group       cpu,memory              %u$cgroupsuffix" >>/etc/cgrules.conf && echo "Cgroup rule creation failed." && rollback
# Restart the service to apply the cgrules config.
echo "Restarting the '$cgrulesengd_service' service."
systemctl restart $cgrulesengd_service || rollback

# Install Sashimono Agent cgcreate service.
# This is a oneshot service which runs only once.
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

# Install xrpl message board systemd service.
echo "Initiating the sashimono agent..."
# Rollback if 'sagent new' failed.
$sashimono_bin/sagent new $sashimono_data $inetaddr $registry_addr $inst_count $cpuMicroSec $ramKB $swapKB $diskKB || rollback

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

# Install xrpl message board systemd service.
echo "Installing Evernode xrpl message board..."

cp -r "$script_dir"/mb-xrpl $sashimono_bin

# Creating message board user.
useradd --shell /usr/sbin/nologin -m "$mb_user"
usermod --lock "$mb_user"
usermod -a -G $admin_group "$mb_user"
loginctl enable-linger "$mb_user" # Enable lingering to support service installation.

# First create the folder from root and then transfer ownership to the user
# since the folder is created in /etc/sashimono directory.
mkdir -p $mb_xrpl_data
[ "$?" == "1" ] && echo "Could not create '$mb_xrpl_data'. Make sure you are running as sudo." && exit 1
# Change ownership to message board user.
chown "$mb_user":"$mb_user" $mb_xrpl_data

mb_user_dir=/home/"$mb_user"
mb_user_id=$(id -u "$mb_user")
mb_user_runtime_dir="/run/user/$mb_user_id"

# Setup env variable for the message board user.
echo "
export XDG_RUNTIME_DIR=$mb_user_runtime_dir" >>"$mb_user_dir"/.bashrc
echo "Updated mb user .bashrc."

user_systemd=""
for ((i = 0; i < 30; i++)); do
    sleep 0.1
    user_systemd=$(sudo -u "$mb_user" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user is-system-running 2>/dev/null)
    [ "$user_systemd" == "running" ] && break
done
[ "$user_systemd" != "running" ] && echo "NO_MB_USER_SYSTEMD" && rollback

# Generate beta host account.
! sudo -u $mb_user MB_DATA_DIR=$mb_xrpl_data node $mb_xrpl_bin betagen $hook_address && echo "XRPLACC_FAILURE" && rollback
# Register the host on Evernode.
! sudo -u $mb_user MB_DATA_DIR=$mb_xrpl_data node $mb_xrpl_bin register \
    $countrycode $cpuMicroSec $ramKB $swapKB $diskKB $description && echo "REG_FAILURE" && rollback

! (sudo -u $mb_user mkdir -p "$mb_user_dir"/.config/systemd/user/) && echo "Message board user systemd folder creation failed" && rollback

# StartLimitIntervalSec=0 to make unlimited retries. RestartSec=5 is to keep 5 second gap between restarts.
echo "[Unit]
Description=Running and monitoring evernode xrpl transactions.
After=network.target
StartLimitIntervalSec=0
[Service]
Type=simple
WorkingDirectory=$mb_xrpl_bin
Environment=\"MB_DATA_DIR=$mb_xrpl_data\"
ExecStart=/usr/bin/node $mb_xrpl_bin
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target" | sudo -u $mb_user tee "$mb_user_dir"/.config/systemd/user/$mb_xrpl_service.service > /dev/null

# This service needs to be restarted when mb-xrpl.cfg is changed.
sudo -u "$mb_user" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user enable $mb_xrpl_service
sudo -u "$mb_user" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user start $mb_xrpl_service
echo "Installed Evernode xrpl message board."

echo "Sashimono installed successfully."
exit 0
