#!/bin/bash
# Sashimono agent installation script. This supports fresh installations as well as upgrades.
# This must be executed with root privileges.

[ "$UPGRADE" == "0" ] && echo "---Sashimono installer---" || echo "---Sashimono installer (upgrade)---"

# TODO : Remove this line once the previous evernode alias (/usr/bin/evernode) is updated in all hosts.
[[ -z "${EVERNODE_GOVERNOR_ADDRESS}" ]] && export EVERNODE_GOVERNOR_ADDRESS="rNPPwSnXDkcGDUaY5gKJzt33bkVRMVVLKX"

inetaddr=${1}
init_peer_port=${2}
init_user_port=${3}
countrycode=${4}
inst_count=${5}
cpuMicroSec=${6}
ramKB=${7}
swapKB=${8}
diskKB=${9}
lease_amount=${10}
rippled_server=${11}
xrpl_account_address=${12}
xrpl_account_secret=${13}
email_address=${14}
tls_key_file=${15}
tls_cert_file=${16}
tls_cabundle_file=${17}
description=${18}

script_dir=$(dirname "$(realpath "$0")")

function stage() {
    echo "STAGE $1" # This is picked up by the setup console output filter.
}

function rollback() {
    [ "$UPGRADE" == "1" ] && echo "Evernode update failed. You can try again later. If the problem persists, please uninstall and re-install Evernode." && exit 1
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

function set_cpu_info() {
    [ -z $cpu_model_name ] && cpu_model_name=$(lscpu | grep -i "^Model name:" | sed 's/Model name://g; s/[#$%*@;]//g' | xargs | tr ' ' '_')
    [ -z $cpu_count ] && cpu_count=$(lscpu | grep -i "^CPU(s):" | sed 's/CPU(s)://g' | xargs)
    [ -z $cpu_mhz ] && cpu_mhz=$(lscpu | grep -i "^CPU MHz:" | sed 's/CPU MHz://g' | sed 's/\.[0-9]*//g' | xargs)
}

function enable_evernode_auto_updater() {
    # Create the service.
    echo "[Unit]
Description=Service for the Evernode auto-update.
After=network.target
[Service]
User=root
Group=root
Type=oneshot
ExecStart=/usr/bin/evernode update -q
[Install]
WantedBy=multi-user.target" >/etc/systemd/system/$EVERNODE_AUTO_UPDATE_SERVICE.service

    # Create a timer for the service (every two hours).
    echo "[Unit]
Description=Timer for the Evernode auto-update.
# Allow manual starts
RefuseManualStart=no
# Allow manual stops
RefuseManualStop=no
[Timer]
Unit=$EVERNODE_AUTO_UPDATE_SERVICE.service
OnCalendar=0/12:00:00
# Execute job if it missed a run due to machine being off
Persistent=true
# To prevent rush time, adding 2 hours delay
RandomizedDelaySec=7200
[Install]
WantedBy=timers.target" >/etc/systemd/system/$EVERNODE_AUTO_UPDATE_SERVICE.timer

    # Reload the systemd daemon.
    systemctl daemon-reload

    echo "Enabling Evernode auto update service..."
    systemctl enable $EVERNODE_AUTO_UPDATE_SERVICE.service

    echo "Enabling Evernode auto update timer..."
    systemctl enable $EVERNODE_AUTO_UPDATE_SERVICE.timer
    echo "Starting Evernode auto update timer..."
    systemctl start $EVERNODE_AUTO_UPDATE_SERVICE.timer
}

function setup_certbot() {
    stage "Setting up letsencrypt certbot"

    # We assume snap is already installed (https://certbot.eff.org/instructions?ws=other&os=ubuntufocal)
    snap install core && snap refresh core && snap install --classic certbot
    ! [ -f /snap/bin/certbot ] && echo "certbot not found" && return 1
    [ -f /usr/bin/certbot ] || ln -s /snap/bin/certbot /usr/bin/certbot || return 1

    # allow http (port 80) in firewall for certbot domain validation
    ufw allow http comment sashimono-certbot

    # Setup the certificates
    echo "Running certbot certonly"
    certbot certonly -n -d $inetaddr --agree-tos --email $email_address --standalone || return 1

    # We need to place our script in certbook deploy hooks dir.
    local deploy_hooks_dir="/etc/letsencrypt/renewal-hooks/deploy"
    ! [ -d $deploy_hooks_dir ] && echo "$deploy_hooks_dir not found" && return 1

    # Setup deploy hook (update contract certs on certbot SSL auto-renewal)
    local deploy_hook="/etc/letsencrypt/renewal-hooks/deploy/sashimono-$inetaddr.sh"
    echo "Setting up certbot deploy hook $deploy_hook"
    echo "#!/bin/sh
# This script is placed by Sashimono for automatic updataing of contract SSL certs.
# Domain name: $inetaddr
certname=\$(basename \$RENEWED_LINEAGE)
[ \"\$certname\" = \"$inetaddr\" ] && evernode applyssl \$RENEWED_LINEAGE/privkey.pem \$RENEWED_LINEAGE/fullchain.pem" >$deploy_hook
    chmod +x $deploy_hook
}

function setup_tls_certs() {
    mkdir -p $SASHIMONO_DATA/tls

    if [ "$tls_key_file" == "letsencrypt" ]; then

        ! setup_certbot && echo "Error when setting up letsencrypt SSL certificate." && rollback
        cp /etc/letsencrypt/live/$inetaddr/privkey.pem $SASHIMONO_DATA/contract_template/cfg/tlskey.pem
        cp /etc/letsencrypt/live/$inetaddr/fullchain.pem $SASHIMONO_DATA/contract_template/cfg/tlscert.pem

    elif [ "$tls_key_file" == "self" ]; then
        # If user has not provided certs we generate self-signed ones.
        stage "Generating self-signed certificates"
        ! openssl req -newkey rsa:2048 -new -nodes -x509 -days 365 -keyout $SASHIMONO_DATA/contract_template/cfg/tlskey.pem \
            -out $SASHIMONO_DATA/contract_template/cfg/tlscert.pem -subj "/C=$countrycode/CN=$inetaddr" &&
            echo "Error when generating self-signed certificate." && rollback

    elif [ -f "$tls_key_file" ] && [ -f "$tls_cert_file" ]; then

        stage "Transfering certificate files"

        cp $tls_key_file $SASHIMONO_DATA/contract_template/cfg/tlskey.pem
        cp $tls_cert_file $SASHIMONO_DATA/contract_template/cfg/tlscert.pem
        # ca bundle is optional.
        [ "$tls_cabundle_file" != "-" ] && [ -f "$tls_cabundle_file" ] &&
            cat $tls_cabundle_file >>$SASHIMONO_DATA/contract_template/cfg/tlscert.pem

    else
        echo "Error when setting up SSL certificate." && rollback
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

! set_cpu_info && echo "Fetching CPU info failed" && rollback

# Copy contract template and licence file (delete existing)
# Backup the ssl cert files if exists
tmp=$(mktemp -d)
[ "$UPGRADE" != "0" ] && cp $SASHIMONO_DATA/contract_template/cfg/{tlskey.pem,tlscert.pem} "$tmp"/
rm -r "$SASHIMONO_DATA"/{contract_template,licence.txt} >/dev/null 2>&1
cp -r "$script_dir"/{contract_template,licence.txt} $SASHIMONO_DATA
[ "$UPGRADE" != "0" ] && cp "$tmp"/{tlskey.pem,tlscert.pem} $SASHIMONO_DATA/contract_template/cfg/
rm -r "$tmp"

# Create self signed tls certs on update if not exists
# This is added to auto fix the hosts which got their ssl certificates removed in v0.5.20
[ "$UPGRADE" != "0" ] && ([ ! -f "$SASHIMONO_DATA/contract_template/cfg/tlskey.pem" ] || [ ! -f "$SASHIMONO_DATA/contract_template/cfg/tlscert.pem" ]) &&
    openssl req -newkey rsa:2048 -new -nodes -x509 -days 365 -keyout $SASHIMONO_DATA/contract_template/cfg/tlskey.pem \
        -out $SASHIMONO_DATA/contract_template/cfg/tlscert.pem -subj "/C=HP/CN=$(jq -r '.hp.host_address' $SASHIMONO_DATA/sa.cfg)"

# Setup tls certs used for contract instance websockets.
[ "$UPGRADE" == "0" ] && setup_tls_certs

# Install Sashimono agent binaries into sashimono bin dir.
cp "$script_dir"/{sagent,hpfs,user-cgcreate.sh,user-install.sh,user-uninstall.sh,docker-registry-uninstall.sh} $SASHIMONO_BIN
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
if [ "$DOCKER_REGISTRY_PORT" != "0" ]; then
    stage "Installing private docker registry"
    # TODO: secure registry configuration
    "$script_dir"/docker-registry-install.sh
    [ "$?" == "1" ] && echo "Private docker registry installation failed." && rollback
else
    echo "Private docker registry installation skipped"
fi

# If installing with sudo, add current logged-in user to Sashimono admin group.
[ -n "$SUDO_USER" ] && usermod -a -G $SASHIADMIN_GROUP $SUDO_USER

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
    chown -R "$MB_XRPL_USER":"$MB_XRPL_USER" $MB_XRPL_DATA

    # Betage and register if not upgrade mode.
    if [ "$UPGRADE" == "0" ]; then
        # Setup and register the account.
        if ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN reginfo basic >/dev/null 2>&1; then
            stage "Configuring host xrpl account"
            echo "Using registry: $EVERNODE_REGISTRY_ADDRESS"

            # Commented for now, because 'betagen' will no longer be used.
            # ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN betagen $EVERNODE_GOVERNOR_ADDRESS $inetaddr $lease_amount $rippled_server $xrpl_account_secret && echo "XRPLACC_FAILURE" && rollback
            # doreg=1

            ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN new $xrpl_account_address $xrpl_account_secret $EVERNODE_GOVERNOR_ADDRESS $inetaddr $lease_amount $rippled_server && echo "XRPLACC_FAILURE" && rollback
            doreg=1
        fi

        # Register the host on Evernode.
        if [ ! -z $doreg ] || ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN reginfo >/dev/null 2>&1; then
            stage "Registering host on Evernode registry $EVERNODE_REGISTRY_ADDRESS"
            set -o pipefail # We need register operation exit code to detect failures (ignore the sed pipe exit code).
            # Append STAGE prefix to the lease offer creation logs, So they would get fetched from setup as stage logs.
            # Add -p to the progress logs so they would be printed overwriting the same line.
            ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN register \
                $countrycode $cpuMicroSec $ramKB $swapKB $diskKB $inst_count $cpu_model_name $cpu_count $cpu_mhz $email_address $description |
                stdbuf --output=L sed -E '/^Creating lease offer/s/^/STAGE /;/^Created lease offer/s/^/STAGE -p /' &&
                echo "REG_FAILURE" && rollback
            set +o pipefail
        fi

        echo "Registered host on Evernode."
    fi
fi

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
    ! $SASHIMONO_BIN/sagent new $SASHIMONO_DATA $inetaddr $init_peer_port $init_user_port $DOCKER_REGISTRY_PORT $inst_count $cpuMicroSec $ramKB $swapKB $diskKB && rollback
fi

if [[ "$NO_MB" == "" && -f $MB_XRPL_DATA/mb-xrpl.cfg ]]; then
    ! sudo -u "$MB_XRPL_USER" MB_DATA_DIR="$MB_XRPL_DATA" node "$MB_XRPL_BIN" upgrade $EVERNODE_GOVERNOR_ADDRESS && rollback
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

    # This service needs to be restarted whenever mb-xrpl.cfg or secret.cfg is changed.
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

stage "Configuring auto updater service"

# Enable the Evernode Auto Updater Service.
enable_evernode_auto_updater

echo "Sashimono installed successfully."

exit 0
