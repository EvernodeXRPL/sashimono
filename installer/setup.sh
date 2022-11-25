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
cloud_storage="https://stevernode.blob.core.windows.net/evernode-dev-bb7ec110-f72e-430e-b297-9210468a4cbb"
setup_script_url="$cloud_storage/setup.sh"
installer_url="$cloud_storage/installer.tar.gz"
licence_url="$cloud_storage/licence.txt"
installer_version_timestamp_file="installer.version.timestamp"
setup_version_timestamp_file="setup.version.timestamp"
default_rippled_server="wss://hooks-testnet-v2.xrpl-labs.com"



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
export EVERNODE_REGISTRY_ADDRESS="raaFre81618XegCrzTzVotAmarBcqNSAvK"
export EVERNODE_AUTO_UPDATE_SERVICE="evernode-auto-update"

# Private docker registry (not used for now)
export DOCKER_REGISTRY_USER="sashidockerreg"
export DOCKER_REGISTRY_PORT=0

# Helper to print multi line text.
# (When passed as a parameter, bash auto strips spaces and indentation which is what we want)
function echomult() {
    echo -e $1
}

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

# Configuring the sashimono service is the last stage of the installation.
# Removing the sashimono service is the first stage of ununstallation.
# So if the service exists, Previous sashimono installation has been complete.
# Creating bin dir is the first stage of installation.
# Removing bin dir is the last stage of uninstalltion.
# So if the service does not exists but the bin dir exists, Previous installation or uninstalltion is failed partially.
if [ -f /etc/systemd/system/$SASHIMONO_SERVICE.service ] && [ -d $SASHIMONO_BIN ] ; then
    [ "$1" == "install" ] \
        && echo "$evernode is already installed on your host. Use the 'evernode' command to manage your host." \
        && exit 1

    [ "$1" != "uninstall" ] && [ "$1" != "status" ] && [ "$1" != "list" ] && [ "$1" != "update" ] && [ "$1" != "log" ] && [ "$1" != "applyssl" ] && [ "$1" != "reconfig" ] \
        && echomult "$evernode host management tool
                \nYour host is registered on $evernode.
                \nSupported commands:
                \nstatus - View $evernode registration info
                \nlist - View contract instances running on this system
                \nlog - Generate evernode log file.
                \napplyssl - Apply new SSL certificates for contracts.
                \reconfig - Change the host configurations.
                \nupdate - Check and install $evernode software updates
                \nuninstall - Uninstall and deregister from $evernode" \
        && exit 1
elif [ -d $SASHIMONO_BIN ] ; then
    [ "$1" != "install" ] && [ "$1" != "uninstall" ] \
        && echomult "$evernode host management tool
                \nYour system has a previous failed partial $evernode installation.
                \nYou can repair previous $evernode installation by installing again.
                \nSupported commands:
                \nuninstall - Uninstall previous $evernode installation" \
        && exit 1

    # If partially installed and interactive mode, Allow user to repair.
    [ "$2" != "-q" ]  && [ "$1" == "install" ] \
        && ! confirm "$evernode host management tool
                \nYour system has a previous failed partial $evernode installation.
                \nYou can run:
                \nuninstall - Uninstall previous $evernode installation.
                \n\nDo you want to repair previous $evernode installation?" \
        && exit 1
else
    [ "$1" != "install" ] \
        && echomult "$evernode host management tool
                \nYour system is not registered on $evernode.
                \nSupported commands:
                \ninstall - Install Sashimono and register on $evernode"\
        && exit 1
fi
mode=$1

if [ "$mode" == "install" ] || [ "$mode" == "uninstall" ] || [ "$mode" == "update" ] || [ "$mode" == "log" ] ; then
    [ -n "$2" ] && [ "$2" != "-q" ] && [ "$2" != "-i" ] && echo "Second arg must be -q (Quiet) or -i (Interactive)" && exit 1
    [ "$2" == "-q" ] && interactive=false || interactive=true
    [ "$EUID" -ne 0 ] && echo "Please run with root privileges (sudo)." && exit 1
fi

# Format the given KB number into GB units.
function GB() {
    echo "$(bc <<<"scale=2; $1 / 1000000") GB"
}

function check_prereq() {
    # Check if node js installed.
    if command -v node &>/dev/null; then
        version=$(node -v | cut -d '.' -f1)
        version=${version:1}
        if [[ $version -lt 16 ]]; then
            echo "$evernode requires NodeJs 16.x or later. You system has NodeJs $version installed. Either remove the NodeJs installation or upgrade to NodeJs 16.x."
            exit 1
        fi
    fi
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

function resolve_filepath() {
    # name reference the variable name provided as first argument.
    local -n filepath=$1
    local option=$2
    local prompt="${*:3} "

    while [ -z "$filepath" ]; do
        read -p "$prompt" filepath </dev/tty

        # if optional accept empty path as "-"
        [ "$option" == "o" ] && [ -z "$filepath" ] && filepath="-"
        
        # Check for valid path.
        ([ "$option" == "r" ] || ([ "$option" == "o" ] && [ "$filepath" != "-" ])) \
            && [ ! -f "$filepath" ] && echo "Invalid file path" && filepath=""
    done
}

function set_domain_certs() {
    if confirm "\nIt is recommended that you obtain an SSL certificate for '$inetaddr' from a trusted certificate authority.
        If you don't provide a certificate, $evernode will generate a self-signed certificate which would not be accepted
        by some clients including web browsers.
        \n\nHave you obtained an SSL certificate for '$inetaddr' from a trusted authority?" ; then
        resolve_filepath tls_key_file r "Please specify location of the private key (usually ends with .key):"
        resolve_filepath tls_cert_file r "Please specify location of the certificate (usually ends with .crt):"
        resolve_filepath tls_cabundle_file o "Please specify location of ca bundle (usually ends with .ca-bundle [Optional]):"
    else
        echo "SSL certificate not provided. $evernode will generate self-signed certificate.\n"
    fi
    return 0
}

function validate_inet_addr_domain() {
    host $inetaddr 2>&1 > /dev/null && return 0
    inetaddr="" && return 1
}

function validate_inet_addr() {
    # inert address cannot be empty and cannot contain spaces.
    [ -z "$inetaddr" ] || [[ $inetaddr = *" "* ]] && inetaddr="" && return 1

    # Attempt to resolve ip (in case inetaddr is a DNS address)
    # This will resolve correctly if inetaddr is a valid ip or dns address.
    local resolved=$(getent hosts $inetaddr | head -1 | awk '{ print $1 }')
    # If invalid, reset inetaddr and return with non-zero code.
    [ -z "$resolved" ] && inetaddr="" && return 1

    return 0
}

function validate_positive_decimal() {
    ! [[ $1 =~ ^(0*[1-9][0-9]*(\.[0-9]+)?|0+\.[0-9]*[1-9][0-9]*)$ ]] && return 1
    return 0
}

function validate_ws_url() {
    ! [[ $1 =~ ^(wss:\/\/.*)$ ]] && return 1
    return 0
}

function set_inet_addr() {

    if $interactive ; then
        echo ""
        if confirm "For greater compatibility with a wide range of clients, it is recommended that you own a domain name
            that others can use to reach your host over internet. If you don't, your host will not be accepted by some clients
            including web browsers. \n\nDo you own a domain name for this host?" ; then
            while [ -z "$inetaddr" ]; do
                read -p "Please specify the domain name that this host is reachable at: " inetaddr </dev/tty
                validate_inet_addr && validate_inet_addr_domain && set_domain_certs && return 0
                echo "Invalid or unreachable domain name."
            done
        fi
    fi

    # Attempt auto-detection.
    if [ "$inetaddr" == "auto" ] || $interactive ; then
        inetaddr=$(hostname -I | awk '{print $1}')
        validate_inet_addr && $interactive && confirm "Detected ip address '$inetaddr'. This needs to be publicly reachable over
                                internet.\n\nIs this the ip address you want others to use to reach your host?" && return 0
        inetaddr=""
    fi

    if $interactive ; then
        while [ -z "$inetaddr" ]; do
            read -p "Please specify the public ip/domain address your server is reachable at: " inetaddr </dev/tty
            validate_inet_addr && return 0
            echo "Invalid ip/domain address."
        done
    fi

   ! validate_inet_addr && echo "Invalid ip/domain address" && exit 1
}

function check_port_validity() {
    # Port should be a number and between 1 through 65535.
    # 1 through 1023 are used by system-supplied TCP/IP applications.
    [[ $1 =~ ^[0-9]+$ ]] && [ $1 -ge 1024 ] && [ $1 -le 65535 ] && return 0
    return 1
}

function set_init_ports() {

    # Take default ports in interactive mode or if 'default' is specified.
    # Picked default ports according to https://en.wikipedia.org/wiki/List_of_TCP_and_UDP_port_numbers
    # (22223 - 23073) and (26000 - 26822) range is uncommon.
    ([ "$init_peer_port" == "default" ] || $interactive) && init_peer_port=22861
    ([ "$init_user_port" == "default" ] || $interactive) && init_user_port=26201

    if $interactive ; then

        if [ -n "$init_peer_port" ] && [ -n "$init_user_port" ] && confirm "Selected default port ranges (Peer: $init_peer_port-$((init_peer_port + alloc_instcount)), User: $init_user_port-$((init_user_port + alloc_instcount))).
                                            This needs to be publicly reachable over internet. \n\nAre these the ports you want to use?" ; then
            return 0
        fi

        init_peer_port=""
        init_user_port=""
        while [ -z "$init_peer_port" ]; do
            read -p "Please specify the starting port of the public 'Peer port range' your server is reachable at: " init_peer_port </dev/tty
            ! check_port_validity $init_peer_port && init_peer_port="" && echo "Invalid port."
        done
        while [ -z "$init_user_port" ]; do
            read -p "Please specify the starting port of the public 'User port range' your server is reachable at: " init_user_port </dev/tty
            ! check_port_validity $init_user_port && init_user_port="" && echo "Invalid port."
        done

    else
        [ -z "$init_peer_port" ] && echo "Invalid starting peer port '$init_peer_port'" && exit 1
        [ -z "$init_user_port" ] && echo "Invalid starting user port '$init_user_port'" && exit 1
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
            ! [[ $ramMB -gt 0 ]] && echo "Invalid ram size." || break
        done

        while true ; do
            read -p "Specify the total Swap in megabytes to distribute among all contract instances: " swapMB </dev/tty
            ! [[ $swapMB -gt 0 ]] && echo "Invalid swap size." || break
        done

        while true ; do
            read -p "Specify the total disk space in megabytes to distribute among all contract instances: " diskMB </dev/tty
            ! [[ $diskMB -gt 0 ]] && echo "Invalid disk size." || break
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
    # [ -z $lease_amount ] && lease_amount=0

    # Lease amount is mandatory field set by the user
    if $interactive; then
        # If user hasn't specified, the default lease amount is taken from the target price set by the purchaser service.
        # echo "Default contract instance lease amount is taken from purchaser service target price."

        # ! confirm "Do you want to specify a contract instance lease amount?" && return 0

        local amount=0
        while true ; do
            read -p "Specify the lease amount in EVRs for your contract instances (per moment charge): " amount </dev/tty
            ! validate_positive_decimal $amount && echo "Lease amount should be a positive numerical value greater than zero." || break
        done

        lease_amount=$amount
    fi
}

function set_rippled_server() {
    [ -z $rippled_server ] && rippled_server=$default_rippled_server

    if $interactive; then
        confirm "Do you want to connect to the default rippled server ('$default_rippled_server')?" && return 0

        local newURL=""

        while true ; do
            read -p "Specify the rippled URL: " newURL </dev/tty
            ! validate_ws_url $newURL && echo "Rippled URL must be a valid URL that starts with 'wss://' ." || break
        done

        rippled_server=$newURL
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

function online_version_timestamp() {
    # Send HTTP HEAD request and get last modified timestamp of the installer package or setup.sh.
    curl --silent --head $1 | grep 'Last-Modified:' | sed 's/[^ ]* //'
}

function install_evernode() {
    local upgrade=$1

    # Get installer version (timestamp). We use this later to check for Evernode software updates.
    local installer_version_timestamp=$(online_version_timestamp $installer_url)
    [ -z "$installer_version_timestamp" ] && echo "Online installer not found." && exit 1
    # Get setup version (timestamp).
    local setup_version_timestamp=$(online_version_timestamp $setup_script_url)

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
    ! create_evernode_alias && install_failure

    # Adding ip address as the host description.
    description=$inetaddr

    echo "Installing Sashimono..."
    # Filter logs with STAGE prefix and ommit the prefix when echoing.
    # If STAGE log contains -p arg, move the cursor to previous log line and overwrite the log.
    ! UPGRADE=$upgrade ./sashimono-install.sh $inetaddr $init_peer_port $init_user_port $countrycode $alloc_instcount \
                            $alloc_cpu $alloc_ramKB $alloc_swapKB $alloc_diskKB $description $lease_amount $rippled_server $tls_key_file $tls_cert_file $tls_cabundle_file 2>&1 \
                            | tee -a $logfile | stdbuf --output=L grep "STAGE" \
                            | while read line ; do [[ $line =~ ^STAGE[[:space:]]-p(.*)$ ]] && echo -e \\e[1A\\e[K"${line:9}" || echo ${line:6} ; done \
                            && remove_evernode_alias && install_failure
    set +o pipefail

    rm -r $tmp

    # Write the verison timestamp to a file for later updated version comparison.
    echo $installer_version_timestamp > $SASHIMONO_DATA/$installer_version_timestamp_file
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
    local latest_installer_script_version=$(online_version_timestamp $installer_url)
    local latest_setup_script_version=$(online_version_timestamp $setup_script_url)
    [ -z "$latest_installer_script_version" ] && echo "Could not check for updates. Online installer not found." && exit 1

    local current_installer_script_version=$(cat $SASHIMONO_DATA/$installer_version_timestamp_file)
    local current_setup_script_version=$(cat $SASHIMONO_DATA/$setup_version_timestamp_file)
    [ "$latest_installer_script_version" == "$current_installer_script_version" ] && [ "$latest_setup_script_version" == "$current_setup_script_version" ] && echo "Your $evernode installation is up to date." && exit 0

    echo "New $evernode update available. Setup will re-install $evernode with updated software. Your account and contract instances will be preserved."
    $interactive && ! confirm "\nDo you want to install the update?" && exit 1

    echo "Starting upgrade..."
    # Alias for setup.sh is created during 'install_evernode' too. 
    # If only the setup.sh is updated but not the installer, then the alias should be created again.
    if [ "$latest_installer_script_version" != "$current_installer_script_version" ] ; then
        uninstall_evernode 1
        install_evernode 1
    elif [ "$latest_setup_script_version" != "$current_setup_script_version" ] ; then
        [ -d $log_dir ] || mkdir -p $log_dir
        logfile="$log_dir/installer-$(date +%s).log"
        remove_evernode_alias
        ! create_evernode_alias && echo "Alias creation failed."
        echo $latest_setup_script_version > $SASHIMONO_DATA/$setup_version_timestamp_file
    fi

    echo "Upgrade complete."
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
        echo ""
        echo "Auto updater service log:"
        journalctl -u evernode-auto-update | tail -n 200
    } > "$tempfile" 2>&1
    echo "Evernode log saved to $tempfile"
}

# Create a copy of this same script as a command.
function create_evernode_alias() {
    ! curl -fsSL $setup_script_url --output $evernode_alias >> $logfile 2>&1 && echo "Error in creating alias." && return 1
    ! chmod +x $evernode_alias >> $logfile 2>&1 && echo "Error in changing permission for the alias." && return 1
    return 0
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

function apply_ssl() {
    [ "$EUID" -ne 0 ] && echo "Please run with root privileges (sudo)." && exit 1
    
    local tls_key_file=$1
    local tls_cert_file=$2
    local tls_cabundle_file=$3

    ([ ! -f "$tls_key_file" ] || [ ! -f "$tls_cert_file" ] || \
        ([ "$tls_cabundle_file" != "" ] && [ ! -f "$tls_cabundle_file" ])) &&
            echo -e "One or more invalid files provided.\nusage: applyssl <private key file> <cert file> <ca bundle file (optional)>" && exit 1

    cp $tls_key_file $SASHIMONO_DATA/contract_template/cfg/tlskey.pem || exit 1
    cp $tls_cert_file $SASHIMONO_DATA/contract_template/cfg/tlscert.pem || exit 1
    # ca bundle is optional.
    [ "$tls_cabundle_file" != "" ] && (cat $tls_cabundle_file >> $SASHIMONO_DATA/contract_template/cfg/tlscert.pem || exit 1)

    sashi list | jq -rc '.[]' | while read -r inst; do \
        local instuser=$(echo $inst | jq -r '.user'); \
        local instname=$(echo $inst | jq -r '.name'); \
        echo -e "\nStopping contract instance $instname" && sashi stop -n $instname && \
            echo "Updating SSL certificates" && \
            cp $SASHIMONO_DATA/contract_template/cfg/tlskey.pem $SASHIMONO_DATA/contract_template/cfg/tlscert.pem /home/$instuser/$instname/cfg/ && \
            chmod 644 /home/$instuser/$instname/cfg/tlscert.pem && chmod 600 /home/$instuser/$instname/cfg/tlskey.pem && \
            chown -R $instuser:$instuser /home/$instuser/$instname/cfg/*.pem && \
            echo -e "Starting contract instance $instname" && sashi start -n $instname; \
    done
}

function reconfig() {
    [ "$EUID" -ne 0 ] && echo "Please run with root privileges (sudo)." && exit 1

    echo "Staring reconfiguration..."

    if ( [[ $alloc_cpu -gt 0 ]] || [[ $alloc_ramKB -gt 0 ]] || [[ $alloc_swapKB -gt 0 ]] || [[ $alloc_diskKB -gt 0 ]] || [[ $alloc_instcount -gt 0 ]] ) ; then

        echo -e "Using allocation"
        [[ $alloc_cpu -gt 0 ]] && echo -e "$alloc_cpu US CPU"
        [[ $alloc_ramKB -gt 0 ]] && echo -e "$(GB $alloc_ramKB) RAM"
        [[ $alloc_swapKB -gt 0 ]] && echo -e "$(GB $alloc_swapKB) Swap"
        [[ $alloc_diskKB -gt 0 ]] && echo -e "$(GB $alloc_diskKB) disk space"
        [[ $alloc_instcount -gt 0 ]] && echo -e "Distributed among $alloc_instcount contract instances\n"
        
        echo "Configuaring sashimono..."

        ! $SASHIMONO_BIN/sagent reconfig $SASHIMONO_DATA $alloc_instcount $alloc_cpu $alloc_ramKB $alloc_swapKB $alloc_diskKB &&
            echo "There was an error in updating sashimono configuration." && exit 1

        # Update cgroup allocations.
        ( [ $alloc_cpu -gt 0 ] || [ $alloc_ramKB -gt 0 ] || [ $alloc_swapKB -gt 0 ] [ $alloc_instcount -gt 0 ] ) &&
            echo "Updating the cgroup configuration..." &&
            ! $SASHIMONO_BIN/user-cgcreate.sh $SASHIMONO_DATA && echo "Error occured while upgrading cgroup allocations\n" && exit 1

        # Update disk quotas.
        if ( [ $alloc_diskKB -gt 0 ] || [ $alloc_instcount -gt 0 ] ) ; then
            echo "Updating the disk quotas..."

            users=$(cut -d: -f1 /etc/passwd | grep "^$SASHIUSER_PREFIX" | sort)
            readarray -t userarr <<<"$users"
            sashiusers=()
            for user in "${userarr[@]}"; do
                [ ${#user} -lt 24 ] || [ ${#user} -gt 32 ] || [[ ! "$user" =~ ^$SASHIUSER_PREFIX[0-9]+$ ]] && continue
                sashiusers+=("$user")
            done

            saconfig="$SASHIMONO_DATA/sa.cfg"
            max_storage_kbytes=$(jq '.system.max_storage_kbytes' $saconfig)
            max_instance_count=$(jq '.system.max_instance_count' $saconfig)
            disk=$(expr $max_storage_kbytes / $max_instance_count)
            ucount=${#sashiusers[@]}
            if [ $ucount -gt 0 ]; then
                for user in "${sashiusers[@]}"; do
                    setquota -g -F vfsv0 "$user" "$disk" "$disk" 0 0 /
                done
            fi
        fi
    fi

    if ( [ ! -z "$rippled_server" ] || [[ $lease_amount -gt 0 ]] || [[ $alloc_instcount -gt 0 ]] ) ; then

        [ ! -z "$rippled_server" ] && echo -e "Using the rippled address '$rippled_server'.\n"
        [[ $lease_amount -gt 0 ]] && (( $(echo "$lease_amount > 0" |bc -l) )) && echo -e "Using lease amount $lease_amount EVRs.\n"
        
        echo "Configuaring message board..."

        ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN reconfig $lease_amount $rippled_server $alloc_instcount &&
            echo "There was an error in updating message board configuration." && exit 1

        # Restart the message board service.
        if ( [ $lease_amount -gt 0 ] || [ ! -z "$rippled_server" ] ) ; then
            echo "Restarting the message board..."

            mb_user_id=$(id -u "$MB_XRPL_USER")
            mb_user_runtime_dir="/run/user/$mb_user_id"
            sudo -u "$MB_XRPL_USER" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user start $MB_XRPL_SERVICE
        fi
    fi
}

# Begin setup execution flow --------------------

echo "Thank you for trying out $evernode!"

if [ "$mode" == "install" ]; then

    if ! $interactive ; then
        inetaddr=${3}           # IP or DNS address.
        init_peer_port=${4}     # Starting peer port for instances.
        init_user_port=${5}     # Starting user port for instances.
        countrycode=${6}        # 2-letter country code.
        alloc_cpu=${7}          # CPU microsec to allocate for contract instances (max 1000000).
        alloc_ramKB=${8}        # RAM to allocate for contract instances.
        alloc_swapKB=${9}       # Swap to allocate for contract instances.
        alloc_diskKB=${10}      # Disk space to allocate for contract instances.
        alloc_instcount=${11}   # Total contract instance count.
        lease_amount=${12}      # Contract instance lease amount in EVRs.
        rippled_server=${13}    # Ripple URL
        tls_key_file=${14}      # File path to the tls private key.
        tls_cert_file=${15}     # File path to the tls certificate.
        tls_cabundle_file=${16} # File path to the tls ca bundle.
    fi

    $interactive && ! confirm "This will install Sashimono, Evernode's contract instance management software,
            and register your system as an $evernode host.\n
            \nThe setup will go through the following steps:\n
            - Check your system compatibility for $evernode.\n
            - Collect information about your system to be published to users.\n
            - Generate a testnet XRPL account to receive $evernode hosting rewards.\n
            \nContinue?" && exit 1

    check_sys_req
    check_prereq

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

    set_init_ports
    echo -e "Using port ranges (Peer: $init_peer_port-$((init_peer_port + alloc_instcount)), User: $init_user_port-$((init_user_port + alloc_instcount))).\n"

    set_lease_amount
    # Commented for future consideration.
    # (( $(echo "$lease_amount > 0" |bc -l) )) && echo -e "Using lease amount $lease_amount EVRs.\n" || echo -e "Using anchor tenant target price as lease amount.\n"
    (( $(echo "$lease_amount > 0" |bc -l) )) && echo -e "Using lease amount $lease_amount EVRs.\n"

    set_rippled_server
    echo -e "Using the rippled address '$rippled_server'.\n"

    echo "Starting installation..."
    install_evernode 0

    echomult "Installation successful! Installation log can be found at $logfile
            \n\nYour system is now registered on $evernode. You can check your system status with 'evernode status' command."

elif [ "$mode" == "uninstall" ]; then

    # echomult "\nWARNING! Uninstalling will deregister your host from $evernode and you will LOSE YOUR XRPL ACCOUNT credentials
    #         stored in '$MB_XRPL_DATA/mb-xrpl.cfg' and '$MB_XRPL_DATA/secret.cfg'. This is irreversible. Make sure you have your account address and
    #         secret elsewhere before proceeding.\n"

    # $interactive && ! confirm "\nHave you read above warning and backed up your account credentials?" && exit 1
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

elif [ "$mode" == "applyssl" ]; then
    apply_ssl $2 $3 $4

elif [ "$mode" == "reconfig" ]; then
    alloc_cpu=${2}          # CPU microsec to allocate for contract instances (max 1000000).
    alloc_ramKB=${3}        # RAM to allocate for contract instances.
    alloc_swapKB=${4}       # Swap to allocate for contract instances.
    alloc_diskKB=${5}      # Disk space to allocate for contract instances.
    alloc_instcount=${6}   # Total contract instance count.
    lease_amount=${7}      # Contract instance lease amount in EVRs.
    rippled_server=${8}    # Ripple URL

    [ ! -z $alloc_cpu ] && [ $alloc_cpu != 0 ] && ( ! ( validate_positive_decimal $alloc_cpu && [[ $alloc_cpu -le 1000000 ]] ) ) && echo "Invalid cpu allocation." && exit 1
    [ ! -z $alloc_ramKB ] && [ $alloc_ramKB != 0 ] && ! validate_positive_decimal $alloc_ramKB && echo "Invalid ram size." && exit 1
    [ ! -z $alloc_swapKB ] && [ $alloc_swapKB != 0 ] && ! validate_positive_decimal $alloc_swapKB && echo "Invalid swap size." && exit 1
    [ ! -z $alloc_diskKB ] && [ $alloc_diskKB != 0 ] && ! validate_positive_decimal $alloc_diskKB && echo "Invalid disk size." && exit 1
    [ ! -z $alloc_instcount ] && [ $alloc_instcount != 0 ] && ! validate_positive_decimal $alloc_instcount && echo "Invalid instance count." && exit 1
    [ ! -z $lease_amount ] && [ $lease_amount != 0 ] && ! validate_positive_decimal $lease_amount && echo "Invalid lease amount." && exit 1
    [ ! -z $rippled_server ] && ! validate_ws_url $rippled_server && echo "Rippled URL must be a valid URL that starts with 'wss://' ." && exit 1

    reconfig

    echo "Successfully changed the configurations!"
fi

[ "$mode" != "uninstall" ] && check_installer_pending_finish

exit 0