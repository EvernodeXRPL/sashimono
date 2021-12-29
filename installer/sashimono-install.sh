#!/bin/bash
# Sashimono agent installation script.
# This must be executed with root privileges.
# -q for non-interactive (quiet) mode (This will skip the installation of xrpl message board)

echo "---Sashimono installer---"

user_bin=/usr/bin
sashimono_bin=/usr/bin/sashimono-agent
mb_xrpl_bin=$sashimono_bin/mb-xrpl
docker_bin=$sashimono_bin/dockerbin
sashimono_data=/etc/sashimono
mb_xrpl_data=$sashimono_data/mb-xrpl
sashimono_service="sashimono-agent"
cgcreate_service="sashimono-cgcreate"
mb_xrpl_service="sashimono-mb-xrpl"
hook_address="rntPzkVidFxnymL98oF3RAFhhBSmsyB5HP"
group="sashiuser"
admin_group="sashiadmin"
mb_user="sashimbxrpl"
cgroupsuffix="-cg"
registryuser="sashidockerreg"
registryport=4444
script_dir=$(dirname "$(realpath "$0")")
quiet=$1

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
    "$script_dir"/sashimono-uninstall.sh -q # Quiet uninstall.
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

# Detect self host address
selfip=$(hostname -I)

# Install private docker registry.
# (Disabled until secure registry configuration)
# ./registry-install.sh $docker_bin $registryuser $registryport
# [ "$?" == "1" ] && rollback
# registry_addr=$selfip:$registryport

# Setting up Sashimono admin group.
! groupadd $admin_group && echo "Admin group creation failed." && rollback

# Setup Sashimono data dir.
cp -r "$script_dir"/contract_template $sashimono_data

if [ "$quiet" == "-q" ]; then

    # We are in the quiet mode. Hence we auto-generate an XRPL test account and token details for the host.
    # (This is done for testing purposes during development)

    xrpl_faucet_url="https://hooks-testnet.xrpl-labs.com/newcreds"
    hook_secret="shgNKT14iCV6S4HdT9r7mgqyx94Xt"
    func_url="https://func-hotpocket.azurewebsites.net/api/evrfaucet?code=pPUyV1q838ryrihA5NVlobVXj8ZGgn9HsQjGGjl6Vhgxlfha4/xCgQ=="

    # Generate new fauset account.
    echo "Generating XRP faucet account..."
    new_acc=$(curl -X POST $xrpl_faucet_url)
    # If result is not a json, account generation failed.
    [[ ! "$new_acc" =~ \{.+\} ]] && echo "Xrpl faucet account generation failed." && rollback
    xrp_address=$(echo $new_acc | jq -r '.address')
    xrp_secret=$(echo $new_acc | jq -r '.secret')
    ([ "$xrp_address" == "" ] || [ "$xrp_address" == "null" ] ||
        [ "$xrp_secret" == "" ] || [ "$xrp_secret" == "null" ]) && echo "Invalid generated xrpl account details: $new_acc" && rollback

    # Wait a small interval so the XRP account gets replicated in the testnet (otherwise we may get 'Account not found' errors).
    sleep 4

    # Setup the host xrpl account with an EVR balance and default rippling flag.
    echo "Setting up host XRP account..."
    acc_setup_func="$func_url&action=setuphost&hookaddr=$hook_address&hooksecret=$hook_secret&addr=$xrp_address&secret=$xrp_secret"
    func_code=$(curl -o /dev/null -s -w "%{http_code}\n" -d "" -X POST "$acc_setup_func")
    [ "$func_code" != "200" ] && echo "Host XRP account setup failed. code:$func_code" && rollback

    # Generate random hosting token.
    token=$(tr -dc A-Z </dev/urandom | head -c 3)

    echo "Auto-generated host information."

else

    echo "Please answer following questions to setup Evernode xrpl message board."
    # Ask for input until a correct value is given
    while [[ ! "$token" =~ ^[A-Z]{3}$ ]]; do
        read -p "Token name? " token </dev/tty
        [[ ! "$token" =~ ^[A-Z]{3}$ ]] && echo "Token name should be 3 UPPERCASE letters."
    done
    while [[ -z "$xrp_address" ]]; do
        read -p "XRPL account address? " xrp_address </dev/tty
    done
    while [[ -z "$xrp_secret" ]]; do
        read -p "XRPL account secret? " xrp_secret </dev/tty
    done
fi

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
$sashimono_bin/sagent new $sashimono_data $selfip $registry_addr || rollback

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

# Populate the message board config file.
# Run as the message board user.
sudo -u $mb_user MB_DATA_DIR=$mb_xrpl_data node $mb_xrpl_bin new "$xrp_address" "$xrp_secret" $hook_address "$token"

! (sudo -u $mb_user mkdir -p "$mb_user_dir"/.config/systemd/user/) && echo "user systemd folder creation failed" && rollback

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
