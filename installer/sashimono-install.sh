#!/bin/bash
# Sashimono agent installation script.
# This must be executed with root privileges.
# -q for non-interactive (quiet) mode (This will skip the installation of xrpl message board)

user_bin=/usr/bin
sashimono_bin=/usr/bin/sashimono-agent
mb_xrpl_bin=$sashimono_bin/mb-xrpl
docker_bin=$sashimono_bin/dockerbin
sashimono_data=/etc/sashimono
sashimono_conf=$sashimono_data/sa.cfg
mb_xrpl_data=$sashimono_data/mb-xrpl
mb_xrpl_conf=$mb_xrpl_data/mb-xrpl.cfg
sashimono_service="sashimono-agent"
cgcreate_service="sashimono-cgcreate"
mb_xrpl_service="sashimono-mb-xrpl"
hook_address="r3q12vGjcvXXEvRvcDwczesmG2jR81tvsE"
group="sashimonousers"
admin_group="sashiadmin"
cgroupsuffix="-cg"
registryuser="sashidockerreg"
registryport=4444
script_dir=$(dirname "$(realpath "$0")")
def_cgrulesengd_service="cgrulesengdsvc"
quiet=$1

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
mkdir -p $mb_xrpl_data
[ "$?" == "1" ] && echo "Could not create '$mb_xrpl_data'. Make sure you are running as sudo." && exit 1

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
    hook_secret="sh77XLdVqt4tKwoHknkHijiEjenJb"
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

    # Generate random details for instance size, location and token.
    instance_size="AUTO "$(tr -dc A-Z </dev/urandom | head -c 10)
    location="AUTO "$(tr -dc A-Z </dev/urandom | head -c 5)
    token=$(tr -dc A-Z </dev/urandom | head -c 3)

    echo "Auto-generated host information."

else

    echo "Please answer following questions to setup Evernode xrpl message board."
    # Ask for input until a correct value is given
    while [ -z "$instance_size" ] || [[ "$instance_size" =~ .*\;.* ]]; do
        read -p "Instance size? " instance_size </dev/tty
        ([ -z "$instance_size" ] && echo "Instance size cannot be empty.") || ([[ "$instance_size" =~ .*\;.* ]] && echo "Instance size cannot include ';'.")
    done
    while [ -z "$location" ] || [[ "$location" =~ .*\;.* ]]; do
        read -p "Location? " location </dev/tty
        ([ -z "$location" ] && echo "Location cannot be empty.") || ([[ "$location" =~ .*\;.* ]] && echo "Location cannot include ';'.")
    done
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
    # Ask for cgroup rule generator service until a valid service provided.
    while true; do
        read -p "Enter your cgroup rule generator service name (default: $def_cgrulesengd_service)? " cgrulesengd_service </dev/tty
        # Set service name to default if user input is empty.
        [ -z "$cgrulesengd_service" ] && cgrulesengd_service="$def_cgrulesengd_service"
        # Remove '.service' if user has given the full name.
        cgrulesengd_service=$(echo $cgrulesengd_service | awk '{print tolower($0)}' | sed 's/\.service$//')
        # Break the loop if service is valid and exist.
        [ -f /etc/systemd/system/"$cgrulesengd_service".service ] && break
        echo "$cgrulesengd_service systemd service does not exist."
    done
fi

# Set cgrulesengd_service to default if it's still empty.
if [[ -z "$cgrulesengd_service" ]]; then
    cgrulesengd_service="$def_cgrulesengd_service"
    [ ! -f /etc/systemd/system/"$cgrulesengd_service".service ] && echo "$cgrulesengd_service systemd service does not exist." && rollback
fi

# Setting up cgroup rules.
echo "Creating cgroup rules..."
! groupadd $group && echo "Group creation failed." && rollback
! echo "@$group       cpu,memory              %u$cgroupsuffix" >>/etc/cgrules.conf && echo "Cgroup rule creation failed." && rollback
# Restart the service to apply the cgrules config.
echo "Restarting the $cgrulesengd_service.service."
systemctl restart $cgrulesengd_service || rollback

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

# Install xrpl message board systemd service.
echo "Initiating the sashimono agent..."
# Rollback if 'sagent new' failed.
$sashimono_bin/sagent new $sashimono_data $cgrulesengd_service $selfip $registry_addr || rollback

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
(! echo "{\"host\":{\"location\":\"$location\",\"instanceSize\":\"$instance_size\"},\"xrpl\":{\"address\":\"$xrp_address\",\"secret\":\"$xrp_secret\",\"token\":\"$token\",\"hookAddress\":\"$hook_address\",\"regFeeHash\":\"\"}}" | jq . >$mb_xrpl_conf) && rollback

# StartLimitIntervalSec=0 to make unlimited retries. RestartSec=5 is to keep 5 second gap between restarts.
echo "[Unit]
Description=Running and monitoring evernode xrpl transactions.
After=network.target
StartLimitIntervalSec=0
[Service]
User=root
Group=root
Type=simple
WorkingDirectory=$mb_xrpl_bin
Environment=\"MB_DATA_DIR=$mb_xrpl_data\"
ExecStart=node $mb_xrpl_bin
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target" >/etc/systemd/system/$mb_xrpl_service.service

# This service needs to be restarted when mb-xrpl.cfg is changed.
systemctl enable $mb_xrpl_service
systemctl start $mb_xrpl_service
echo "Installed Evernode xrpl message board."

echo "Sashimono installed successfully."
exit 0
