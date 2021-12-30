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
mkdir -p $SASHIMONO_BIN
[ "$?" == "1" ] && echo "Could not create '$SASHIMONO_BIN'. Make sure you are running as sudo." && exit 1
mkdir -p $DOCKER_BIN
[ "$?" == "1" ] && echo "Could not create '$DOCKER_BIN'. Make sure you are running as sudo." && exit 1
mkdir -p $SASHIMONO_DATA
[ "$?" == "1" ] && echo "Could not create '$SASHIMONO_DATA'. Make sure you are running as sudo." && exit 1

echo "Installing Sashimono..."

function rollback() {
    echo "Rolling back sashimono installation."
    "$script_dir"/sashimono-uninstall.sh
    echo "Rolled back the installation."
    exit 1
}

# Install Sashimono agent binaries into sashimono bin dir.
cp "$script_dir"/{sagent,hpfs,user-cgcreate.sh,user-install.sh,user-uninstall.sh} $SASHIMONO_BIN
chmod -R +x $SASHIMONO_BIN

# Blake3
[ ! -f /usr/local/lib/libblake3.so ] && cp "$script_dir"/libblake3.so /usr/local/lib/
# Update linker library cache.
ldconfig

# Install Sashimono CLI binaries into user bin dir.
cp "$script_dir"/sashi $USER_BIN

# Download and install rootless dockerd.
"$script_dir"/docker-install.sh $DOCKER_BIN

# Check whether docker installation dir is still empty.
[ -z "$(ls -A $DOCKER_BIN 2>/dev/null)" ] && echo "Rootless Docker installation failed." && rollback

# Install private docker registry.
# (Disabled until secure registry configuration)
# ./registry-install.sh $DOCKER_BIN $REGISTRY_USER $REGISTRY_PORT
# [ "$?" == "1" ] && rollback
# registry_addr=$inetaddr:$REGISTRY_PORT

# Setting up Sashimono admin group.
! groupadd $SASHIADMIN_GROUP && echo "Admin group creation failed." && rollback

# Setup Sashimono data dir.
cp -r "$script_dir"/contract_template $SASHIMONO_DATA

# Find the cgroups rules engine service.
cgrulesengd_filename=$(basename $(grep "ExecStart.*=.*/cgrulesengd$" /etc/systemd/system/*.service | head -1 | awk -F : ' { print $1 } '))
cgrulesengd_service="${cgrulesengd_filename%.*}"
[ -z "$cgrulesengd_service" ] && echo "cgroups rules engine service does not exist." && rollback

# Setting up cgroup rules.
echo "Creating cgroup rules..."
! groupadd $SASHIUSER_GROUP && echo "Group creation failed." && rollback
! echo "@$SASHIUSER_GROUP       cpu,memory              %u$CG_SUFFIX" >>/etc/cgrules.conf && echo "Cgroup rule creation failed." && rollback
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
ExecStart=$SASHIMONO_BIN/user-cgcreate.sh $SASHIMONO_DATA
[Install]
WantedBy=multi-user.target" >/etc/systemd/system/$CGCREATE_SERVICE.service

# Install xrpl message board systemd service.
echo "Initiating the sashimono agent..."
# Rollback if 'sagent new' failed.
$SASHIMONO_BIN/sagent new $SASHIMONO_DATA $inetaddr $registry_addr $inst_count $cpuMicroSec $ramKB $swapKB $diskKB || rollback

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
WorkingDirectory=$SASHIMONO_BIN
ExecStart=$SASHIMONO_BIN/sagent run $SASHIMONO_DATA
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target" >/etc/systemd/system/$SASHIMONO_SERVICE.service

systemctl daemon-reload
systemctl enable $CGCREATE_SERVICE
systemctl start $CGCREATE_SERVICE
systemctl enable $SASHIMONO_SERVICE
systemctl start $SASHIMONO_SERVICE
# Both of these services needed to be restarted if sa.cfg max instance resources are manually changed.

# Install xrpl message board systemd service.
echo "Installing Evernode xrpl message board..."

cp -r "$script_dir"/mb-xrpl $SASHIMONO_BIN

# Creating message board user.
useradd --shell /usr/sbin/nologin -m "$MB_XRPL_USER"
usermod --lock "$MB_XRPL_USER"
usermod -a -G $SASHIADMIN_GROUP "$MB_XRPL_USER"
loginctl enable-linger "$MB_XRPL_USER" # Enable lingering to support service installation.

# First create the folder from root and then transfer ownership to the user
# since the folder is created in /etc/sashimono directory.
mkdir -p $MB_XRPL_DATA
[ "$?" == "1" ] && echo "Could not create '$MB_XRPL_DATA'. Make sure you are running as sudo." && exit 1
# Change ownership to message board user.
chown "$MB_XRPL_USER":"$MB_XRPL_USER" $MB_XRPL_DATA

mb_user_dir=/home/"$MB_XRPL_USER"
mb_user_id=$(id -u "$MB_XRPL_USER")
mb_user_runtime_dir="/run/user/$mb_user_id"

# Setup env variable for the message board user.
echo "
export XDG_RUNTIME_DIR=$mb_user_runtime_dir" >>"$mb_user_dir"/.bashrc
echo "Updated mb user .bashrc."

user_systemd=""
for ((i = 0; i < 30; i++)); do
    sleep 0.1
    user_systemd=$(sudo -u "$MB_XRPL_USER" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user is-system-running 2>/dev/null)
    [ "$user_systemd" == "running" ] && break
done
[ "$user_systemd" != "running" ] && echo "NO_MB_USER_SYSTEMD" && rollback

# Generate beta host account.
! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN betagen $HOOK_ADDRESS && echo "XRPLACC_FAILURE" && rollback
# Register the host on Evernode.
! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN register \
    $countrycode $cpuMicroSec $ramKB $swapKB $diskKB $description && echo "REG_FAILURE" && rollback

! (sudo -u $MB_XRPL_USER mkdir -p "$mb_user_dir"/.config/systemd/user/) && echo "Message board user systemd folder creation failed" && rollback

# StartLimitIntervalSec=0 to make unlimited retries. RestartSec=5 is to keep 5 second gap between restarts.
echo "[Unit]
Description=Running and monitoring evernode xrpl transactions.
After=network.target
StartLimitIntervalSec=0
[Service]
Type=simple
WorkingDirectory=$MB_XRPL_BIN
Environment=\"MB_DATA_DIR=$MB_XRPL_DATA\"
ExecStart=/usr/bin/node $MB_XRPL_BIN
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target" | sudo -u $MB_XRPL_USER tee "$mb_user_dir"/.config/systemd/user/$MB_XRPL_SERVICE.service > /dev/null

# This service needs to be restarted when mb-xrpl.cfg is changed.
sudo -u "$MB_XRPL_USER" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user enable $MB_XRPL_SERVICE
sudo -u "$MB_XRPL_USER" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user start $MB_XRPL_SERVICE
echo "Installed Evernode xrpl message board."

echo "Sashimono installed successfully."
exit 0