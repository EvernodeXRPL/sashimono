#!/bin/bash
# Sashimono agent installation script. This supports fresh installations as well as upgrades.
# This must be executed with root privileges.

[ "$UPGRADE" == "0" ] && echo "---Sashimono installer---" || echo "---Sashimono installer (upgrade)---"

inetaddr=$1
countrycode=$2
inst_count=$3
cpuMicroSec=$4
ramKB=$5
swapKB=$6
diskKB=$7
description=$8
lease_amount=$9

script_dir=$(dirname "$(realpath "$0")")

function stage() {
    echo "STAGE $1" # This is picked up by the setup console output filter.
}

function rollback() {
    echo "Rolling back sashimono installation."
    "$script_dir"/sashimono-uninstall.sh -f
    echo "Rolled back the installation."
    exit 1
}

function cgrulesengd_servicename() {
    # Find the cgroups rules engine service.
    local cgrulesengd_filepath=$(grep "ExecStart.*=.*/cgrulesengd$" /etc/systemd/system/*.service | head -1 | awk -F : ' { print $1 } ')
    if [ -n "$cgrulesengd_filepath" ]; then
        local cgrulesengd_filename=$(basename $cgrulesengd_filepath)
        echo "${cgrulesengd_filename%.*}"
    fi
}

# Check cgroup rule config exists.
[ ! -f /etc/cgred.conf ] && echo "cgroups is not configured. Make sure you've installed and configured cgroup-tools." && exit 1

# Create bin and data directories if not exist.
mkdir -p $SASHIMONO_BIN
mkdir -p $SASHIMONO_DATA

# Put Sashimono uninstallation into sashimono bin dir.
# We do this at the begining because then if message board registration failed user can uninstall sashimono with evernode command.
cp "$script_dir"/sashimono-uninstall.sh $SASHIMONO_BIN
chmod +x $SASHIMONO_BIN/sashimono-uninstall.sh

# Setting up Sashimono admin group.
! grep -q $SASHIADMIN_GROUP /etc/group && ! groupadd $SASHIADMIN_GROUP && echo "$SASHIADMIN_GROUP group creation failed." && rollback

# Register host only if NO_MB environment is not set.
if [ "$NO_MB" == "" ]; then
    # Configure message board users and register host.
    echo "Configuaring host registration on Evernode..."

    cp -r "$script_dir"/mb-xrpl $SASHIMONO_BIN

    # Creating message board user (if not exists).
    if ! grep -q "^$MB_XRPL_USER:" /etc/passwd; then
        useradd --shell /usr/sbin/nologin -m $MB_XRPL_USER
        usermod --lock $MB_XRPL_USER
        usermod -a -G $SASHIADMIN_GROUP $MB_XRPL_USER
        loginctl enable-linger $MB_XRPL_USER # Enable lingering to support service installation.
    fi

    # First create the folder from root and then transfer ownership to the user
    # since the folder is created in /etc/sashimono directory.
    ! mkdir -p $MB_XRPL_DATA && echo "Could not create '$MB_XRPL_DATA'. Make sure you are running as sudo." && exit 1
    # Change ownership to message board user.
    chown "$MB_XRPL_USER":"$MB_XRPL_USER" $MB_XRPL_DATA

    # Generate beta host account (if not already setup).
    if ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN reginfo basic >/dev/null 2>&1; then
        stage "Configuring host xrpl account"
        ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN betagen $EVERNODE_REGISTRY_ADDRESS $inetaddr $lease_amount && echo "XRPLACC_FAILURE" && rollback
        doreg=1
    fi

    # Register the host on Evernode.
    if [ ! -z $doreg ] || ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN reginfo >/dev/null 2>&1; then
        stage "Registering host on Evernode and Creating lease offers (This might take a while!)"
        ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN register \
            $countrycode $cpuMicroSec $ramKB $swapKB $diskKB $inst_count $description && echo "REG_FAILURE" && rollback
    fi

    echo "Registered host on Evernode."
fi

# Copy contract template (delete existing)
rm -r "$SASHIMONO_DATA"/contract_template >/dev/null 2>&1
cp -r "$script_dir"/contract_template $SASHIMONO_DATA

# Install Sashimono agent binaries into sashimono bin dir.
cp "$script_dir"/{sagent,hpfs,user-cgcreate.sh,user-install.sh,user-uninstall.sh} $SASHIMONO_BIN
chmod -R +x $SASHIMONO_BIN

# Copy Blake3 and update linker library cache.
[ ! -f /usr/local/lib/libblake3.so ] && cp "$script_dir"/libblake3.so /usr/local/lib/ && ldconfig

# Install Sashimono CLI binaries into user bin dir.
cp "$script_dir"/sashi $USER_BIN

# Download and install rootless dockerd.
stage "Installing docker packages"
# Create docker bin directory.
mkdir -p $DOCKER_BIN
"$script_dir"/docker-install.sh $DOCKER_BIN

# Check whether docker installation dir is still empty.
[ -z "$(ls -A $DOCKER_BIN 2>/dev/null)" ] && echo "Rootless Docker installation failed." && rollback

# Install private docker registry.
# stage "Installing private docker registry"
# (Disabled until secure registry configuration)
# ./registry-install.sh $DOCKER_BIN $DOCKER_REGISTRY_USER $DOCKER_REGISTRY_PORT
# [ "$?" == "1" ] && rollback
# registry_addr=$inetaddr:$DOCKER_REGISTRY_PORT

# If installing with sudo, add current logged-in user to Sashimono admin group.
[ -n "$SUDO_USER" ] && usermod -a -G $SASHIADMIN_GROUP $SUDO_USER

stage "Configuring Sashimono services"

cgrulesengd_service=$(cgrulesengd_servicename)
[ -z "$cgrulesengd_service" ] && echo "cgroups rules engine service does not exist." && rollback

# Setting up cgroup rules with sashiusers group (if not already setup).
echo "Creating cgroup rules..."
! grep -q $SASHIUSER_GROUP /etc/group && ! groupadd $SASHIUSER_GROUP && echo "$SASHIUSER_GROUP group creation failed." && rollback
if ! grep -q $SASHIUSER_GROUP /etc/cgrules.conf; then
    ! echo "@$SASHIUSER_GROUP       cpu,memory              %u$CG_SUFFIX" >>/etc/cgrules.conf && echo "Cgroup rule creation failed." && rollback
    # Restart the service to apply the cgrules config.
    echo "Restarting the '$cgrulesengd_service' service."
    systemctl restart $cgrulesengd_service || rollback
fi

# Install Sashimono Agent cgcreate service.
# This is a oneshot service which runs once at system startup. The intention is to run 'cgcreate' for
# all sashimono users every time the system boots up.
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

echo "Configuring sashimono agent service..."

# Create sashimono agent config (if not exists).
if [ -f $SASHIMONO_DATA/sa.cfg ]; then
    echo "Existing Sashimono data directory found. Updating..."
    ! $SASHIMONO_BIN/sagent upgrade $SASHIMONO_DATA && rollback
else
    ! $SASHIMONO_BIN/sagent new $SASHIMONO_DATA $inetaddr $inst_count $cpuMicroSec $ramKB $swapKB $diskKB && rollback
fi

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
# Here, $SASHIMONO_SERVICE is only enabled. Not started. It'll be started after pending reboot checks at
# the bottom of this script.
# Both of these services needed to be restarted if sa.cfg max instance resources are manually changed.

# Install xrpl message board only of NO_MB environment is not set.
if [ "$NO_MB" == "" ]; then
    # Install xrpl message board systemd service.
    echo "Installing Evernode xrpl message board..."

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

    stage "Configuring xrpl message board service"
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
    WantedBy=default.target" | sudo -u $MB_XRPL_USER tee "$mb_user_dir"/.config/systemd/user/$MB_XRPL_SERVICE.service >/dev/null

    # This service needs to be restarted whenever mb-xrpl.cfg is changed.
    sudo -u "$MB_XRPL_USER" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user enable $MB_XRPL_SERVICE
    # We only enable this service. It'll be started after pending reboot checks at the bottom of this script.
    echo "Installed Evernode xrpl message board."
fi

# If there's no pending reboot, start the sashimono and message board services now. Otherwise
# they'll get started at next startup.
if [ ! -f /run/reboot-required.pkgs ] || [ ! -n "$(grep sashimono /run/reboot-required.pkgs)" ]; then
    echo "Starting the sashimono and message board services."
    systemctl start $SASHIMONO_SERVICE

    if [ "$NO_MB" == "" ]; then
        sudo -u "$MB_XRPL_USER" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user start $MB_XRPL_SERVICE
    fi
fi

echo "Sashimono installed successfully."
exit 0
