#!/bin/bash
# Evernode host setup tool to manage Sashimono installation and host registration.
# This script is also used as the 'evernode' cli alias after the installation.
# usage: ./setup.sh install

evernode="Evernode beta"
maxmind_creds="687058:FtcQjM0emHFMEfgI"
cgrulesengd_default="cgrulesengd"
alloc_ratio=80
ramKB_per_instance=524288
instances_per_core=3
evernode_alias=/usr/bin/evernode
log_dir=/tmp/evernode-beta
cloud_storage="https://stevernode.blob.core.windows.net/evernode-dev"
setup_script_url="$cloud_storage/setup.sh"
installer_url="$cloud_storage/installer.tar.gz"
licence_url="$cloud_storage/licence.txt"
installer_version_timestamp_file="installer.version.timestamp"
setup_version_timestamp_file="setup.version.timestamp"


# export vars used by Sashimono installer.
export USER_BIN=/usr/bin
export SASHIMONO_BIN=/usr/bin/sashimono
export MB_XRPL_BIN=$SASHIMONO_BIN/mb-xrpl
export DOCKER_BIN=$SASHIMONO_BIN/dockerbin
export SASHIMONO_DATA=/etc/sashimono
export MB_XRPL_DATA=$SASHIMONO_DATA/mb-xrpl
export SASHIMONO_SERVICE="sashimono-agent"
export CGCREATE_SERVICE="sashimono-cgcreate"
export MB_XRPL_SERVICE="sashimono-mb-xrpl"
export SASHIADMIN_GROUP="sashiadmin"
export SASHIUSER_GROUP="sashiuser"
export SASHIUSER_PREFIX="sashi"
export MB_XRPL_USER="sashimbxrpl"
export CG_SUFFIX="-cg"
export EVERNODE_REGISTRY_ADDRESS="rDsg8R6MYfEB7Da861ThTRzVUWBa3xJgWL"

# Private docker registry (not used for now)
export DOCKER_REGISTRY_USER="sashidockerreg"
export DOCKER_REGISTRY_PORT=0

# Configuring the sashimono service is the last stage of the installation.
# So if the service exists, Previous sashimono installation has been complete.
[ -f /etc/systemd/system/$SASHIMONO_SERVICE.service ] && sashimono_installed=true || sashimono_installed=false

# Helper to print multi line text.
# (When passed as a parameter, bash auto strips spaces and indentation which is what we want)
function echomult() {
    echo -e $1
}

# The set of commands supported differs based on whether Sashimono is installed or not.
if ! $sashimono_installed ; then
    # If sashimono is not installed but there's a sashimono binary directory, The previous installation is a failed attempt.
    # So, user can reinstall or uninstall the previous partial failed attempt.
    if [ ! -d $SASHIMONO_BIN ] ; then
        [ "$1" != "install" ] \
            && echomult "$evernode host management tool
                    \nYour system is not registered on $evernode.
                    \nSupported commands:
                    \ninstall - Install Sashimono and register on $evernode"\
            && exit 1
    else
        [ "$1" != "install" ] && [ "$1" != "uninstall" ] \
            && echomult "$evernode host management tool
                    \nYour system has a previous failed partial $evernode installation.
                    \nSupported commands:
                    \ninstall - Re-install Sashimono and register on $evernode
                    \nuninstall - Uninstall previous $evernode installations"\
            && exit 1
    fi
else
    [ "$1" == "install" ] \
        && echo "$evernode is already installed on your host. Use the 'evernode' command to manage your host." \
        && exit 1

    [ "$1" != "install" ] && [ "$1" != "uninstall" ] && [ "$1" != "status" ] && [ "$1" != "list" ] && [ "$1" != "update" ] && [ "$1" != "log" ] \
        && echomult "$evernode host management tool
                \nYour host is registered on $evernode.
                \nSupported commands:
                \nstatus - View $evernode registration info
                \nlist - View contract instances running on this system
                \nlog - Generate evernode log file.
                \nupdate - Check and install $evernode software updates
                \nuninstall - Uninstall and deregister from $evernode" \
        && exit 1
fi
mode=$1

if [ "$mode" == "install" ] || [ "$mode" == "uninstall" ] || [ "$mode" == "update" ] || [ "$mode" == "log" ] ; then
    [ -n "$2" ] && [ "$2" != "-q" ] && [ "$2" != "-i" ] && echo "Second arg must be -q (Quiet) or -i (Interactive)" && exit 1
    [ "$2" == "-q" ] && interactive=false || interactive=true
    [ "$EUID" -ne 0 ] && echo "Please run with root privileges (sudo)." && exit 1
fi

function confirm() {
    echo -en $1" [Y/n] "
    local yn=""
    read yn </dev/tty
    
    # Default choice is 'y'
    [ -z $yn ] && yn="y"
    while ! [[ $yn =~ ^[Yy|Nn]$ ]]; do
        read -p "'y' or 'n' expected: " yn </dev/tty
    done

    echo "" # Insert new line after answering.
    [[ $yn =~ ^[Yy]$ ]] && return 0 || return 1  # 0 means success.
}

# Format the given KB number into GB units.
function GB() {
    echo "$(bc <<<"scale=2; $1 / 1000000") GB"
}

function check_sys_req() {

    # Assign sys resource info to global vars since these will also be used for instance allocation later.
    ramKB=$(free | grep Mem | awk '{print $2}')
    swapKB=$(free | grep Swap | awk '{print $2}')
    diskKB=$(df | grep -w /home | head -1 | awk '{print $4}')
    [ -z "$diskKB" ] && diskKB=$(df | grep -w / | head -1 | awk '{print $4}')

    [ "$SKIP_SYSREQ" == "1" ] && echo "System requirements check skipped." && return 0

    local proc1=$(ps --no-headers -o comm 1)
    if [ "$proc1" != "systemd" ]; then
        echo "$evernode host installation requires systemd. Your system does not have systemd running. Aborting."
        exit 1
    fi

    local os=$(grep -ioP '^ID=\K.+' /etc/os-release)
    local osversion=$(grep -ioP '^VERSION_ID=\K.+' /etc/os-release)

    if [ "$os" != "ubuntu" ] || [ "$osversion" != '"20.04"' ] || [ $ramKB -lt 2000000 ] || [ $swapKB -lt 2000000 ] || [ $diskKB -lt 4000000 ]; then
        echomult "Your system specs are:
            \n OS: $os $osversion
            \n RAM: $(GB $ramKB)
            \n Swap: $(GB $swapKB)
            \n Disk space (/home): $(GB $diskKB)
            \n$evernode host registration requires Ubuntu 20.04 with 2 GB RAM, 2 GB Swap and 4 GB free disk space for /home.
            \nYour system does not meet some of the requirements. Aborting."
        exit 1
    fi

    echo "System check complete. Your system is capable of becoming an $evernode host."
}

function resolve_ip_addr() {
    # Attempt to resolve ip (in case inetaddr is a DNS address)
    # This will resolve correctly if inetaddr is a valid ip or dns address.
    local ipaddr=$(getent hosts $inetaddr | head -1 | awk '{ print $1 }')

    # If invalid, reset inetaddr and return with non-zero code.
    if [ -z "$ipaddr" ] ; then
        inetaddr=""
        return 1
    fi
}

function check_inet_addr_validity() {
    # inert address cannot be empty and cannot contain spaces.
    if [ -z "$inetaddr" ] || [[ $inetaddr = *" "* ]] ; then
        inetaddr=""
        return 1
    else
        return 0
    fi
}

function set_inet_addr() {

    # Attempt to auto-detect in interactive mode or if 'auto' is specified.
    ([ "$inetaddr" == "auto" ] || $interactive) && inetaddr=$(hostname -I | awk '{print $1}')
    resolve_ip_addr

    if $interactive ; then

        if [ -n "$inetaddr" ] && confirm "Detected ip address '$inetaddr'. This needs to be publicly reachable over
                                            internet. \n\nIs this the IP/DNS address you want to use?" ; then
            return 0
        fi

        inetaddr=""
        while [ -z "$inetaddr" ]; do
            # This will be asked if auto-detection fails or if user wants to specify manually.
            read -p "Please specify the public IP/DNS address your server is reachable at: " inetaddr </dev/tty
            check_inet_addr_validity || echo "Invalid IP/DNS address."
        done

    else
        [ -z "$inetaddr" ] && echo "Invalid IP/DNS address '$inetaddr'" && exit 1
    fi
}

# Validate country code and convert to uppercase if valid.
function resolve_countrycode() {
    # If invalid, reset countrycode and return with non-zero code.
    if ! [[ $countrycode =~ ^[A-Za-z][A-Za-z]$ ]] ; then
        countrycode=""
        return 1
    else
        countrycode=$(echo $countrycode | tr 'a-z' 'A-Z')
        return 0
    fi
}

function set_country_code() {

    # Attempt to auto-detect in interactive mode or if 'auto' is specified.
    if [ "$countrycode" == "auto" ] || $interactive ; then
        echo "Checking country code..."
        echo "Using GeoLite2 data created by MaxMind, available from https://www.maxmind.com"

        # MaxMind needs a ip address to detect country code. DNS is not supported by it.
        # Use getent to resolve ip address in case inetaddr is a DNS name.
        local mxm_ip=$(getent hosts $inetaddr | head -1 | awk '{ print $1 }')
        # If getent fails (mxm_ip empty) for some reason, keep using inetaddr for MaxMind api call.
        [ -z "$mxm_ip" ] && mxm_ip="$inetaddr"

        local detected=$(curl -s -u "$maxmind_creds" "https://geolite.info/geoip/v2.1/country/$mxm_ip?pretty" | grep "iso_code" | head -1 | awk '{print $2}')
        countrycode=${detected:1:2}
        resolve_countrycode || echo "Could not detect country code."
    fi

    if $interactive ; then

        # Uncomment this if we want the user to manually change the auto-detected country code.
        # if [ -n "$countrycode" ] && ! confirm "Based on the internet address '$inetaddr' we have detected that your country
        #                                         code is '$countrycode'. Do you want to specify a different country code" ; then
        #     return 0
        # fi
        # countrycode=""

        while [ -z "$countrycode" ]; do
            # This will be asked if auto-detection fails or if user wants to specify manually.
            read -p "Please specify the two-letter country code where your server is located in (eg. AU): " countrycode </dev/tty
            resolve_countrycode || echo "Invalid country code."
        done

    else
        resolve_countrycode || (echo "Invalid country code '$countrycode'" && exit 1)
    fi
}

function set_cgrules_svc() {
    local filepath=$(grep "ExecStart.*=.*/cgrulesengd$" /etc/systemd/system/*.service | head -1 | awk -F : ' { print $1 } ')
    if [ -n "$filepath" ] ; then
        local filename=$(basename $filepath)
        cgrulesengd_service="${filename%.*}"
    fi
    # If service not detected, use the default name.
    [ -z "$cgrulesengd_service" ] && cgrulesengd_service=$cgrulesengd_default || echo "cgroups rules engine service found: '$cgrulesengd_service'"
}

function set_instance_alloc() {
    [ -z $alloc_ramKB ] && alloc_ramKB=$(( (ramKB / 100) * alloc_ratio ))
    [ -z $alloc_swapKB ] && alloc_swapKB=$(( (swapKB / 100) * alloc_ratio ))
    [ -z $alloc_diskKB ] && alloc_diskKB=$(( (diskKB / 100) * alloc_ratio ))
    [ -z $alloc_cpu ] && alloc_cpu=$(( (1000000 / 100) * alloc_ratio ))

    # If instance count is not specified, decide it based on some rules.
    if [ -z $alloc_instcount ]; then
        # Instance count based on total RAM
        local ram_c=$(( alloc_ramKB / ramKB_per_instance ))
        # Instance count based on no. of CPU cores.
        local cores=$(grep -c ^processor /proc/cpuinfo)
        local cpu_c=$(( cores * instances_per_core ))

        # Final instance count will be the lower of the two.
        alloc_instcount=$(( ram_c < cpu_c ? ram_c : cpu_c ))
    fi


    if $interactive; then
        echomult "Based on your system resources, we have chosen the following allocation:\n
                $(GB $alloc_ramKB) RAM\n
                $(GB $alloc_swapKB) Swap\n
                $(GB $alloc_diskKB) disk space\n
                Distributed among $alloc_instcount contract instances"
        confirm "\nIs this the allocation you want to use?" && return 0

        local ramMB=0 swapMB=0 diskMB=0

        while true ; do
            read -p "Specify the number of contract instances that you wish to host: " alloc_instcount </dev/tty
            ! [[ $alloc_instcount -gt 0 ]] && echo "Invalid instance count." || break
        done

        while true ; do
            read -p "Specify the total RAM in megabytes to distribute among all contract instances: " ramMB </dev/tty
            ! [[ $ramMB -gt 0 ]] && echo "Invalid amount." || break
        done

        while true ; do
            read -p "Specify the total Swap in megabytes to distribute among all contract instances: " swapMB </dev/tty
            ! [[ $swapMB -gt 0 ]] && echo "Invalid amount." || break
        done

        while true ; do
            read -p "Specify the total disk space in megabytes to distribute among all contract instances: " diskMB </dev/tty
            ! [[ $diskMB -gt 0 ]] && echo "Invalid amount." || break
        done

        alloc_ramKB=$(( ramMB * 1000 ))
        alloc_swapKB=$(( swapMB * 1000 ))
        alloc_diskKB=$(( diskMB * 1000 ))
    fi

    if ! [[ $alloc_ramKB -gt 0 ]] || ! [[ $alloc_swapKB -gt 0 ]] || ! [[ $alloc_diskKB -gt 0 ]] ||
       ! [[ $alloc_cpu -gt 0 ]] || ! [[ $alloc_instcount -gt 0 ]]; then
        echo "Invalid allocation." && exit 1
    fi
}

function set_lease_amount() {
    # We take the default lease amount as 0, So it is taken from the purchaser target price.
    [ -z $lease_amount ] && lease_amount=0

    # if $interactive; then
        # Temperory disable option to take lease amount from purchaser service.

        # If user hasn't specified, the default lease amount is taken from the target price set by the purchaser service.
        # echo "Default contract instance lease amount is taken from purchaser service target price."

        # ! confirm "Do you want to specify a contract instance lease amount?" && return 0

        # local amount=0

        # while true ; do
        #     read -p "Specify the lease amount in EVRs for your contract instances: " amount </dev/tty
        #     ! [[ $amount =~ ^(0*[1-9][0-9]*(\.[0-9]+)?|0+\.[0-9]*[1-9][0-9]*)$ ]] && echo "Lease amount should be a positive numerical value greater than zero." || break
        # done

        # lease_amount=$amount
    # fi
}

function install_failure() {
    echo "There was an error during installation. Please provide the file $logfile to Evernode team. Thank you."
    exit 1
}

function uninstall_failure() {
    echo "There was an error during uninstallation."
    exit 1
}

function online_version_timestamp() {
    # Send HTTP HEAD request and get last modified timestamp of the installer package or setup.sh.
    curl --silent -head $1 | grep 'Last-Modified:' | sed 's/[^ ]* //'
}

function install_evernode() {
    local upgrade=$1

    # Get installer version (timestamp). We use this later to check for Evernode software updates.
    local installer_version_timestamp=$(online_version_timestamp $installer_url)
    [ -z "$installer_version_timestamp" ] && echo "Online installer not found." && exit 1

    local tmp=$(mktemp -d)
    cd $tmp
    curl --silent $installer_url --output installer.tgz
    tar zxf $tmp/installer.tgz --strip-components=1
    rm installer.tgz

    set -o pipefail # We need installer exit code to detect failures (ignore the tee pipe exit code).
    mkdir -p $log_dir
    logfile="$log_dir/installer-$(date +%s).log"

    if [ "$upgrade" == "0" ] ; then
        echo "Installing prerequisites..."
        ! ./prereq.sh $cgrulesengd_service 2>&1 \
                                | tee -a $logfile | stdbuf --output=L grep "STAGE" | cut -d ' ' -f 2- && install_failure
    fi

    # Create evernode cli alias at the begining.
    # So, if the installation attempt failed user can uninstall the failed installation using evernode commands.
    create_evernode_alias $setup_script_url 0

    # Adding ip address as the host description.
    description=$inetaddr

    echo "Installing Sashimono..."
    # Filter logs with STAGE prefix and ommit the prefix when echoing.
    # If STAGE log contains -p arg, move the cursor to previous log line and overwrite the log.
    ! UPGRADE=$upgrade ./sashimono-install.sh $inetaddr $countrycode $alloc_instcount \
                            $alloc_cpu $alloc_ramKB $alloc_swapKB $alloc_diskKB $description $lease_amount 2>&1 \
                            | tee -a $logfile | stdbuf --output=L grep "STAGE" \
                            | while read line ; do [[ $line =~ ^STAGE[[:space:]]-p(.*)$ ]] && echo -e \\e[1A\\e[K"${line:9}" || echo ${line:6} ; done \
                            && remove_evernode_alias && install_failure
    set +o pipefail

    rm -r $tmp

    # Write the verison timestamp to a file for later updated version comparison.
    echo $installer_version_timestamp > $SASHIMONO_DATA/$installer_version_timestamp_file
    
    local setup_version_timestamp=$(online_version_timestamp $setup_script_url)
    echo $setup_version_timestamp > $SASHIMONO_DATA/$setup_version_timestamp_file
}

function uninstall_evernode() {

    local upgrade=$1

    # Check for existing contract instances.
    local users=$(cut -d: -f1 /etc/passwd | grep "^$SASHIUSER_PREFIX" | sort)
    readarray -t userarr <<<"$users"
    local sashiusers=()
    for user in "${userarr[@]}"; do
        [ ${#user} -lt 24 ] || [ ${#user} -gt 32 ] || [[ ! "$user" =~ ^$SASHIUSER_PREFIX[0-9]+$ ]] && continue
        sashiusers+=("$user")
    done
    local ucount=${#sashiusers[@]}

    if [ "$upgrade" == "0" ] ; then
        $interactive && [ $ucount -gt 0 ] && ! confirm "This will delete $ucount contract instances. \n\nDo you still want to uninstall?" && exit 1
        ! $interactive && echo "$ucount contract instances will be deleted."
    fi

    [ "$upgrade" == "0" ] && echo "Uninstalling..." ||  echo "Uninstalling for upgrade..."
    ! UPGRADE=$upgrade $SASHIMONO_BIN/sashimono-uninstall.sh $2 && uninstall_failure

    # Remove the evernode alias at the end.
    # So, if the uninstallation failed user can try uninstall again with evernode commands.
    remove_evernode_alias
}

function update_evernode() {
    echo "Checking for updates..."
    local latest=$(online_version_timestamp $installer_url)
    [ -z "$latest" ] && echo "Could not check for updates. Online installer not found." && exit 1

    local current=$(cat $SASHIMONO_DATA/$installer_version_timestamp_file)
    [ "$latest" == "$current" ] && echo "Your $evernode installation is up to date." && exit 0

    echo "New $evernode update available. Setup will re-install $evernode with updated software. Your account and contract instances will be preserved."
    $interactive && ! confirm "\nDo you want to install the update?" && exit 1

    uninstall_evernode 1
    echo "Starting upgrade..."
    install_evernode 1
    echo "Upgrade complete."

    # Update the setup Script Alias
    local latest_setup_script_version=$(online_version_timestamp $setup_script_url)
    local current_setup_script_version=$(cat $SASHIMONO_DATA/$setup_version_timestamp_file)
    ! [ "$latest_setup_script_version" == "$current_setup_script_version" ] && create_evernode_alias $setup_script_url 1
}

function create_log() {
    tempfile=$(mktemp /tmp/evernode.XXXXXXXXX.log)
    {
        echo "System:"
        uname -r
        lsb_release -a
        echo ""
        echo "sa.cfg:"
        cat "$SASHIMONO_DATA/sa.cfg"
        echo ""
        echo "mb-xrpl.cfg:"
        cat "$MB_XRPL_DATA/mb-xrpl.cfg"
        echo ""
        echo "Sashimono log:"
        journalctl -u sashimono-agent.service | tail -n 200
        echo ""
        echo "Message board log:"
        sudo -u sashimbxrpl bash -c  journalctl --user -u sashimono-mb-xrpl | tail -n 200
    } > "$tempfile" 2>&1
    echo "Evernode log saved to $tempfile"
}

# Create a copy of this same script as a command.
function create_evernode_alias() {
    local update = $2
    ! curl -fsSL $1 --output $evernode_alias >> $logfile 2>&1 && ["$update" == "0"] && install_failure
    ! chmod +x $evernode_alias >> $logfile 2>&1 && ["$update" == "0"] && install_failure
}

function remove_evernode_alias() {
    rm $evernode_alias
}

function check_installer_pending_finish() {
    if [ -f /run/reboot-required.pkgs ] && [ -n "$(grep sashimono /run/reboot-required.pkgs)" ]; then
        echo "Your system needs to be rebooted in order to complete Sashimono installation."
        $interactive && confirm "Reboot now?" && reboot
        ! $interactive && echo "Rebooting..." && reboot
        return 0
    else
        # If reboot not required, check whether re-login is required in case the setup was run with sudo.
        # This is because the user account gets added to sashiadmin group and re-login is needed for group permission to apply.
        # without this, user cannot run "sashi" cli commands without sudo.
        if [ "$mode" == "install" ] && [ -n "$SUDO_USER" ] ; then
            echo "You need to logout and log back in, to complete Sashimono installation."
            return 0
        else
            return 1
        fi
    fi
}

function reg_info() {
    echo ""
    if MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN reginfo ; then
        echo -e "\nYour account details are stored in $MB_XRPL_DATA/mb-xrpl.cfg and $MB_XRPL_DATA/secret.cfg."
    fi
}

# Begin setup execution flow --------------------

echo "Thank you for trying out $evernode!"

if [ "$mode" == "install" ]; then

    if ! $interactive ; then
        inetaddr=${3}           # IP or DNS address.
        countrycode=${4}        # 2-letter country code.
        alloc_cpu=${5}          # CPU microsec to allocate for contract instances (max 1000000).
        alloc_ramKB=${6}        # RAM to allocate for contract instances.
        alloc_swapKB=${7}       # Swap to allocate for contract instances.
        alloc_diskKB=${8}       # Disk space to allocate for contract instances.
        alloc_instcount=${9}    # Total contract instance count.
        lease_amount=${10}      # Contract instance lease amount in EVRs.
    fi

    $interactive && ! confirm "This will install Sashimono, Evernode's contract instance management software,
            and register your system as an $evernode host.\n
            \nThe setup will go through the following steps:\n
            - Check your system compatibility for $evernode.\n
            - Collect information about your system to be published to users.\n
            - Generate a testnet XRPL account to receive $evernode hosting rewards.\n
            \nContinue?" && exit 1

    check_sys_req

    # Check bc command is installed.
    if ! command -v bc &>/dev/null; then
        echo "bc command not found. Installing.."
        apt-get -y install bc >/dev/null
    fi

    # Display licence file and ask for concent.
    printf "\n*****************************************************************************************************\n\n"
    curl --silent $licence_url | cat
    printf "\n\n*****************************************************************************************************\n"
    $interactive && ! confirm "\nDo you accept the terms of the licence agreement?" && exit 1


    $interactive && ! confirm "Make sure your system does not currently contain any other workloads important
            to you since we will be making modifications to your system configuration.
            \nThis is beta software, so there's a chance things can go wrong. \n\nContinue?" && exit 1

    set_inet_addr
    echo -e "Using '$inetaddr' as host internet address.\n"

    set_country_code
    echo -e "Using '$countrycode' as country code.\n"

    set_cgrules_svc
    echo -e "Using '$cgrulesengd_service' as cgroups rules engine service.\n"

    set_instance_alloc
    echo -e "Using allocation $(GB $alloc_ramKB) RAM, $(GB $alloc_swapKB) Swap, $(GB $alloc_diskKB) disk space, $alloc_instcount contract instances.\n"

    set_lease_amount
    # Commented for future consideration.
    # (( $(echo "$lease_amount > 0" |bc -l) )) && echo -e "Using lease amount $lease_amount EVRs.\n" || echo -e "Using anchor tenant target price as lease amount.\n"
    (( $(echo "$lease_amount > 0" |bc -l) )) && echo -e "Using lease amount $lease_amount EVRs.\n"

    echo "Starting installation..."
    install_evernode 0

    echomult "Installation successful! Installation log can be found at $logfile
            \n\nYour system is now registered on $evernode. You can check your system status with 'evernode status' command."

elif [ "$mode" == "uninstall" ]; then

    echomult "\nWARNING! Uninstalling will deregister your host from $evernode and you will LOSE YOUR XRPL ACCOUNT credentials
            stored in '$MB_XRPL_DATA/mb-xrpl.cfg' and '$MB_XRPL_DATA/secret.cfg'. This is irreversible. Make sure you have your account address and
            secret elsewhere before proceeding.\n"

    $interactive && ! confirm "\nHave you read above warning and backed up your account credentials?" && exit 1
    $interactive && ! confirm "\nAre you sure you want to uninstall $evernode?" && exit 1

    # Force uninstall on quiet mode.
    $interactive && uninstall_evernode 0 || uninstall_evernode 0 -f
    echo "Uninstallation complete!"

elif [ "$mode" == "status" ]; then
    reg_info

elif [ "$mode" == "list" ]; then
    sashi list

elif [ "$mode" == "update" ]; then
    update_evernode

elif [ "$mode" == "log" ]; then
    create_log
fi

[ "$mode" != "uninstall" ] && check_installer_pending_finish

exit 0