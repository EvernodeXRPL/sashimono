#!/bin/bash
# Evernode host setup tool to manage Sashimono installation and host registration.
# usage: ./setup.sh install

evernode="Evernode beta"
maxmind_creds="653000:0yB7wwsBqCiPO2m6"
cgrulesengd_default="cgrulesengd"
alloc_ratio=80
memKB_per_instance=819200
evernode_alias=/usr/bin/evernode
install_log="evernode-beta-install.log"
script_url="https://sthotpocket.blob.core.windows.net/evernode/setup.sh"
installer="https://sthotpocket.blob.core.windows.net/evernode/sashimono-installer.tar.gz"

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
export REGISTRY_USER="sashidockerreg"
export CG_SUFFIX="-cg"
export REGISTRY_PORT=4444
export HOOK_ADDRESS="rntPzkVidFxnymL98oF3RAFhhBSmsyB5HP"

[ -f $SASHIMONO_DATA/sa.cfg ] && sashimono_installed=true || sashimono_installed=false

# Helper to print multi line text.
# (When passed as a parameter, bash auto strips spaces and indentation which is what we want)
function echomult() {
    echo -e $1
}

# The set of commands supported differs based on whether Sashimono is installed or not.
if ! $sashimono_installed ; then
    [ "$1" != "install" ] \
        && echomult "$evernode host management tool
                \nSupported commands:
                \ninstall - Install Sashimono and register on $evernode" \
        && exit 1
else
    [ "$1" != "uninstall" ] && [ "$1" != "status" ] && [ "$1" != "list" ] \
        && echomult "$evernode host management tool
                \nSupported commands:
                \nstatus - View $evernode registration info
                \nlist - View contract instances running on this system
                \nuninstall - Uninstall and deregister from $evernode" \
        && exit 1
fi
mode=$1

if [ "$mode" == "install" ] || [ "$mode" == "uninstall" ] ; then
    [ -n "$2" ] && [ "$2" != "-q" ] && [ "$2" != "-i" ] && echo "Second arg must be -q (Quiet) or -i (Interactive)" && exit 1
    [ "$2" == "-q" ] && interactive=false || interactive=true
fi

function confirm() {
    echo -en $1" [y/n] "
    local yn=""

    read yn </dev/tty
    while ! [[ $yn =~ ^[Yy|Nn]$ ]]; do
        read -p "'y' or 'n' expected: " yn </dev/tty
    done

    echo "" # Insert new line after answering.
    [[ $yn =~ ^[Yy]$ ]] && return 0 || return 1  # 0 means success.
}

# Format the given KB number into GB units.
function GB() {
    echo "$(bc <<<"scale=2; $1 / 1048576") GB"
}

function check_sys_req() {

    # Assign sys resource info to global vars since these will also be used for instance allocation later.
    ramKB=$(free | grep Mem | awk '{print $2}')
    swapKB=$(free | grep Swap | awk '{print $2}')
    diskKB=$(df | grep -w /home | head -1 | awk '{print $4}')
    [ -z "$diskKB" ] && diskKB=$(df | grep -w / | head -1 | awk '{print $4}')

    [ "$SKIP_SYSREQ" == "1" ] && return 0

    local proc1=$(ps --no-headers -o comm 1)
    if [ "$proc1" != "systemd" ]; then
        echo "$evernode host installation requires systemd. Your system does not have systemd running. Aborting."
        exit 1
    fi

    local os=$(grep -ioP '^ID=\K.+' /etc/os-release)
    local osversion=$(grep -ioP '^VERSION_ID=\K.+' /etc/os-release)

    if [ "$os" != "ubuntu" ] || [ "$osversion" != '"20.04"' ] || [ $ramKB -lt 2000000 ] || [ $diskKB -lt 4194304 ]; then
        echomult "Your system specs are:
            \n OS: $os $osversion
            \n RAM: $(GB $ramKB)
            \n Disk space (/home): $(GB $diskKB)
            \n$evernode host registration requires Ubuntu 20.04 with 2GB RAM and 4GB free disk space for /home.
            \nYour system does not meet some of the requirements. Aborting."
        exit 1
    fi
}

function resolve_ip_addr() {
    # Attempt to resolve ip (in case inetaddr is a DNS address)
    # This will resolve correctly if inetaddr is a valid ip or dns address.
    ipaddr=$(getent hosts $inetaddr | head -1 | awk '{ print $1 }')

    # If invalid, reset inetaddr and return with non-zero code.
    if [ -z "$ipaddr" ] ; then
        inetaddr=""
        return 1
    fi
}

function set_inet_addr() {

    # Attempt to auto-detect in interactive mode or if 'auto' is specified.
    ([[ "$inetaddr"=="auto" ]] || $interactive) && inetaddr=$(hostname -I | awk '{print $1}')
    resolve_ip_addr

    if $interactive ; then
        
        if [ -n "$inetaddr" ] && ! confirm "Detected ip address '$inetaddr'. This will be used to reach contract instances running
                                                on your host. Do you want to specify a different IP or DNS address?" ; then
            return 0
        fi

        inetaddr=""
        while [ -z "$inetaddr" ]; do
            # This will be asked if auto-detection fails or if user wants to specify manually.
            read -p "Please specify the IP or DNS address your server is reachable at: " inetaddr </dev/tty
            resolve_ip_addr || echo "Invalid IP or DNS address."
        done

    else
        [ -z "$inetaddr" ] && echo "Invalid IP or DNS address '$inetaddr'" && exit 1
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
    fi
}

function set_country_code() {
    
    # Attempt to auto-detect in interactive mode or if 'auto' is specified.
    if [[ "$countrycode"=="auto" ]] || $interactive ; then
        echo "Checking country code..."
        echo "Using GeoLite2 data created by MaxMind, available from https://www.maxmind.com"

        local detected=$(curl -s -u "$maxmind_creds" "https://geolite.info/geoip/v2.1/country/$ipaddr?pretty" | grep "iso_code" | head -1 | awk '{print $2}')
        countrycode=${detected:1:2}
        resolve_countrycode || echo "Could not detect country code."
    fi

    if $interactive ; then
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
        resolve_countrycode || echo "Invalid country code '$countrycode'" && exit 1
    fi
}

function set_cgrules_svc() {
    local filename=$(basename $(grep "ExecStart.*=.*/cgrulesengd$" /etc/systemd/system/*.service | head -1 | awk -F : ' { print $1 } '))
    cgrulesengd_service="${filename%.*}"
    # If service not detected, use the default name.
    [ -z "$cgrulesengd_service" ] && cgrulesengd_service=$cgrulesengd_default || echo "cgroups rules engine service found: '$cgrulesengd_service'"
}

function set_instance_alloc() {
    [ -z $alloc_ramKB ] && alloc_ramKB=$(( (ramKB / 100) * alloc_ratio ))
    [ -z $alloc_swapKB ] && alloc_swapKB=$(( (swapKB / 100) * alloc_ratio ))
    [ -z $alloc_diskKB ] && alloc_diskKB=$(( (diskKB / 100) * alloc_ratio ))
    [ -z $alloc_cpu ] && alloc_cpu=$(( (1000000 / 100) * alloc_ratio ))

    # We decide instance count based on total memory (ram+swap)
    [ -z $alloc_instcount ] && alloc_instcount=$(( (alloc_ramKB + alloc_swapKB) / memKB_per_instance ))

    if $interactive; then
        echomult "Based on your system resources, we have chosen the following allocation:\n
                $(GB $alloc_ramKB) RAM\n
                $(GB $alloc_swapKB) Swap\n
                $(GB $alloc_diskKB) disk space\n
                Distributed among $alloc_instcount contract instances"
        ! confirm "Do you wish to change this allocation?" && return 0

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

        alloc_ramKB=$(( ramMB * 1024 ))
        alloc_swapKB=$(( swapMB * 1024 ))
        alloc_diskKB=$(( diskMB * 1024 ))
    fi

    if ! [[ $alloc_ramKB -gt 0 ]] || ! [[ $alloc_swapKB -gt 0 ]] || ! [[ $alloc_diskKB -gt 0 ]] ||
       ! [[ $alloc_cpu -gt 0 ]] || ! [[ $alloc_instcount -gt 0 ]]; then
        echo "Invalid allocation." && exit 1
    fi
}

function install_failure() {
    echo "There was an error during installation. Please provide the file $logfile to Evernode team. Thank you."
    exit 1
}

function uninstall_failure() {
    echo "There was an error during uninstallation."
    exit 1
}

function install_sashimono() {
    echo "Starting Sashimono installation..."

    local tmp=$(mktemp -d)
    cd $tmp
    curl -s $installer --output installer.tgz
    tar zxf $tmp/installer.tgz --strip-components=1
    rm installer.tgz

    set -o pipefail # We need installer exit code to detect failures (ignore the tee pipe exit code).
    logfile=$(mktemp -d)/$install_log
    echo "Installing prerequisites..."
    ! ./prereq.sh $cgrulesengd_service 2>&1 \
                            | tee $logfile | stdbuf --output=L grep "STAGE" | cut -d ' ' -f 2- && install_failure
    echo "Installing Sashimono..."
    ! ./sashimono-install.sh $inetaddr $countrycode $alloc_instcount \
                            $alloc_cpu $alloc_ramKB $alloc_swapKB $alloc_diskKB $description 2>&1 \
                            | tee $logfile | stdbuf --output=L grep "STAGE" | cut -d ' ' -f 2- && install_failure
    set +o pipefail
            
    rm -r $tmp
}

function check_uninstall_users() {
    # Uninstall all contract instance users
    local users=$(cut -d: -f1 /etc/passwd | grep "^$SASHIUSER_PREFIX" | sort)
    readarray -t userarr <<<"$users"
    local sashiusers=()
    for user in "${userarr[@]}"; do
        [ ${#user} -lt 24 ] || [ ${#user} -gt 32 ] || [[ ! "$user" =~ ^$SASHIUSER_PREFIX[0-9]+$ ]] && continue
        sashiusers+=("$user")
    done
    local ucount=${#sashiusers[@]}

    $interactive && [ $ucount -gt 0 ] && ! confirm "This will delete $ucount contract instances. Do you still want to uninstall?" && exit 1
}

function uninstall_sashimono() {

    check_uninstall_users

    echo "Starting Sashimono uninstallation..."

    local tmp=$(mktemp -d)
    cd $tmp
    curl -s $installer --output installer.tgz
    tar zxf $tmp/installer.tgz --strip-components=1
    rm installer.tgz

    logfile=$(mktemp -d)/$uninstall_log
    echo "Uninstalling Sashimono..."
    ! ./sashimono-uninstall.sh && uninstall_failure
    rm -r $tmp
}

# Create a copy of this same script as a command.
function create_evernode_alias() {
    ! curl -fsSL $script_url --output $evernode_alias >> $logfile 2>&1 && install_failure
    ! chmod +x $evernode_alias >> $logfile 2>&1 && install_failure
}

function remove_evernode_alias() {
    rm $evernode_alias
}

function check_reboot_pending() {
    if [ -f /run/reboot-required.pkgs ] && [ -n "$(grep sashimono /run/reboot-required.pkgs)" ]; then
        echo "Your system needs to be rebooted in order to complete Sashimono installation."
        $interactive && confirm "Reboot now?" && reboot
        ! $interactive && echo "Rebooting..." && reboot
        return 0
    else
        return 1
    fi
}

function reg_info() {
    echo ""
    if sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN reginfo ; then
        echo -e "\nYou are receiving $evernode rewards to the Host account. The account secret is stored in $MB_XRPL_DATA/mb-xrpl.cfg"
    fi
}

# Begin setup execution flow --------------------

echo "Thank you for trying out $evernode!"

if [ "$mode" == "install" ]; then

    if ! $sashimono_installed ; then

        if ! $interactive ; then
            inetaddr=${3}           # IP or DNS address.
            countrycode=${4}        # 2-letter country code.
            alloc_cpu=${5}          # CPU microsec to allocate for contract instances.
            alloc_ramKB=${6}        # RAM to allocate for contract instances.
            alloc_swapKB=${7}       # Swap to allocate for contract instances.
            alloc_diskKB=${8}       # Disk space to allocate for contract instances.
            alloc_instcount=${9}    # Total contract instance count.
            description=${10}       # Registration description (underscore for spaces).
        else
            description="Evernode_host"
        fi

        $interactive && ! confirm "This will install Sashimono, Evernode's contract instance management software,
                and register your system as an $evernode host on the public XRPL hooks testnet.\n
                \nThe setup will go through the following steps:\n
                - Check your system compatibility for $evernode.\n
                - Collect information about your system to be published to users.\n
                - Generate a testnet XRPL account to receive $evernode hosting rewards.\n
                \nContinue?" && exit 1
        
        check_sys_req
        echo "System check complete. Your system is capable of becoming an $evernode host."
        $interactive && ! confirm "Make sure your system does not currently contain any other workloads important
                to you since we will be making modifications to your system configuration.
                \nThis is beta software, so there's a chance things can go wrong. Continue?" && exit 1

        set_inet_addr
        echo -e "Using '$inetaddr' as host internet address.\n"

        set_country_code
        echo -e "Using '$countrycode' as country code.\n"

        set_cgrules_svc
        echo -e "Using '$cgrulesengd_service' as cgroups rules engine service.\n"

        set_instance_alloc
        echo -e "Using allocation $(GB $alloc_ramKB) RAM, $(GB $alloc_swapKB) Swap, $(GB $alloc_diskKB) disk space, $alloc_instcount contract instances.\n"

        install_sashimono
        create_evernode_alias

        echomult "Installation successful! Installation log can be found at $logfile
                \n\nYour system is now registered on $evernode. You can check system status with 'evernode status' command."
    else
        echo "Your system is already registered on $evernode. You can check system status with 'evernode status' command."
    fi

    check_reboot_pending

else

    ! $sashimono_installed && echo "Could not find a Sashimono installation on your system." && exit 1

    if [ "$mode" == "uninstall" ]; then

        $interactive && ! confirm "Are you sure want to uninstall Sashimono and deregister from $evernode?" && exit 1

        uninstall_sashimono
        remove_evernode_alias
        echo "Uninstallation complete!"

    elif [ "$mode" == "status" ]; then
        reg_info

    elif [ "$mode" == "list" ]; then
        sashi list
    fi

fi