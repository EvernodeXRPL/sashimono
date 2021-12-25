#!/bin/bash
# Evernode host setup tool to manage Sashimono installation and host registration.

evernode="Evernode beta"
sashimono_data="/etc/sashimono"
mb_data="$sashimono_data_dir/mb-xrpl"
maxmind_creds="653000:0yB7wwsBqCiPO2m6"
cgrulessvc_default="cgrulesengdsvc"
alloc_ratio=80
memKB_per_instance=614400

[ -n "$1" ] && [ "$1" != "-q" ] && [ "$1" != "-i" ] && echo "First arg must be -q (Quiet) or -i (Interactive)" && exit 0

[ "$1" == "-q" ] && interactive=false || interactive=true
[ -f $sashimono_data/sa.cfg ] && sashimono_installed=true || sashimono_installed=false
[ -f $mb_data/mb-xrpl.cfg ] && mb_installed=true || mb_installed=false

inetaddr=$2         # IP or DNS address.
countrycode=$3      # 2-letter country code.
cgrulessvc=$4       # cgroups rules engine service name.
alloc_cpu=$5        # CPU microsec to allocate for contract instances.
alloc_ramKB=$6      # RAM to allocate for contract instances.
alloc_swapKB=$7     # Swap to allocate for contract instances.
alloc_diskKB=$8     # Disk space to allocate for contract instances.
alloc_instcount=$9  # Total contract instance count.

function confirm() {
    echo -en $1" [y/n] "
    local yn=""
    read yn
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
        exit 0
    fi

    local os=$(grep -ioP '^ID=\K.+' /etc/os-release)
    local osversion=$(grep -ioP '^VERSION_ID=\K.+' /etc/os-release)

    if [ "$os" != "ubuntu" ] || [ "$osversion" != '"20.04"' ] || [ $ramKB -lt 2000000 ] || [ $diskKB -lt 4194304 ]; then
        echo -e "Your system specs are:
            OS: $os $osversion
            RAM: $(GB $ramKB)
            Disk space (/home): $(GB $diskKB)"
        echo "$evernode host registration requires Ubuntu 20.04 with 2GB RAM and 4GB free disk space for /home.
             Your system does not meet some of the requirements. Aborting."
        exit 0
    fi
}

function set_inet_addr() {

    # Attempt to auto-detect if not already specified via cli args.
    if [ -z "$inetaddr" ]; then
        inetaddr=$(hostname -I | awk '{print $1}')

        if [ -n "$inetaddr" ] && $interactive && ! confirm "Detected ip address '$inetaddr'. This will be used to reach contract instances running
                                                  on your host. Do you want to specify a different IP or DNS address?" ; then
            return 0
        fi

        # This will be asked if auto-detection fails or if user wants to specify manually.
        $interactive && read -p "Please specify the IP or DNS address your server is reachable at: " inetaddr
    fi

    [ -z "$inetaddr" ] && echo "Invalid IP or DNS address '$inetaddr'" && exit 0

    # Attempt to resolve ip (in case inetaddr is a DNS address)
    ipaddr=$(getent hosts $inetaddr | head -1 | awk '{ print $1 }')
    [ -z "$ipaddr" ] && echo "Failed to resolve IP address of '$inetaddr'" && exit 0
}

function set_country_code() {
    # Attempt to auto-detect if not already specified via cli args.
    if [ -z "$countrycode" ]; then
        echo "Checking country code..."
        echo "Using GeoLite2 data created by MaxMind, available from https://www.maxmind.com"

        local detected=$(curl -s -u "$maxmind_creds" "https://geolite.info/geoip/v2.1/country/$ipaddr?pretty" | grep "iso_code" | head -1 | awk '{print $2}')
        countrycode=${detected:1:2}
        [ -z $countrycode ] && echo "Could not detect country code."

        if [ -n "$countrycode" ] && $interactive && ! confirm "Based on the internet address '$inetaddr' we have detected that your country
                                                              code is '$countrycode'. Do you want to specify a different country code" ; then
            return 0
        fi

        # This will be asked if auto-detection fails or if user wants to specify manually.
        $interactive && read -p "Please specify the two-letter country code where your server is located in (eg. AU): " countrycode
    fi

    ! [[ $countrycode =~ ^[A-Za-z][A-Za-z]$ ]] && echo "Invalid country code '$countrycode'" && exit 0
    countrycode=$(echo $countrycode | tr 'a-z' 'A-Z')
}

function set_cgrules_svc() {
    if [ -z "$cgrulessvc" ]; then
        if $interactive && confirm "Do you have Linux cgroups rules engine service installed already?" ; then
            read -p "Please specify your cgroups rules engine service name: " cgrulessvc
            ! systemctl is-active --quiet $cgrulessvc && echo "$cgrulessvc service does not exist or is not active." && exit 0
        else
            cgrulessvc=$cgrulessvc_default
        fi
    fi

    [ -z "$cgrulessvc" ] && echo "Invalid cgrules engine service name '$cgrulessvc'" && exit 0
}

function set_instance_alloc() {
    [ -z $alloc_ramKB ] && alloc_ramKB=$(( (ramKB / 100) * alloc_ratio ))
    [ -z $alloc_swapKB ] && alloc_swapKB=$(( (swapKB / 100) * alloc_ratio ))
    [ -z $alloc_diskKB ] && alloc_diskKB=$(( (diskKB / 100) * alloc_ratio ))
    [ -z $alloc_cpu ] && alloc_cpu=$(( (1000000 / 100) * alloc_ratio ))

    # We decide instance count based on total memory (ram+swap)
    [ -z $alloc_instcount ] && alloc_instcount=$(( (alloc_ramKB + alloc_swapKB) / memKB_per_instance ))

    if $interactive; then
        ! confirm "Based on your system resources, we will allocate $(GB $alloc_ramKB) RAM, $(GB $alloc_swapKB) Swap
                              and $(GB $alloc_diskKB) disk space to be distributed among $alloc_instcount contract instances.
                              Do you wish to change this allocation?" && return 0

        local ramMB=0 swapMB=0 diskMB=0
        read -p "Specify the number of contract instances that you wish to host: " alloc_instcount
        ! [[ $alloc_instcount -gt 0 ]] && echo "Invalid instance count." && exit 0
        read -p "Specify the total RAM in megabytes to distribute among all contract instances: " ramMB
        ! [[ $ramMB -gt 0 ]] && echo "Invalid amount." && exit 0
        read -p "Specify the total Swap in megabytes to distribute among all contract instances: " swapMB
        ! [[ $swapMB -gt 0 ]] && echo "Invalid amount." && exit 0
        read -p "Specify the total disk space in megabytes to distribute among all contract instances: " diskMB
        ! [[ $diskMB -gt 0 ]] && echo "Invalid amount." && exit 0

        alloc_ramKB=$(( ramMB * 1024 ))
        alloc_swapKB=$(( swapMB * 1024 ))
        alloc_diskKB=$(( diskMB * 1024 ))
    fi

    if ! [[ $alloc_ramKB -gt 0 ]] || ! [[ $alloc_swapKB -gt 0 ]] || ! [[ $alloc_diskKB -gt 0 ]] ||
       ! [[ $alloc_cpu -gt 0 ]] || ! [[ $alloc_instcount -gt 0 ]]; then
        echo "Invalid allocation." && exit 0
    fi
}

# Begin setup execution flow --------------------

echo "Thank you for trying out $evernode!"
if ! $sashimono_installed ; then

    $interactive && ! confirm "This will install Sashimono, Evernode's contract instance management software,
            and register your system as an $evernode host on the public XRPL hooks testnet.\n
            \nThe setup will go through the following steps:\n
            - Check your system compatibility for $evernode.\n
            - Collect information about your system to be published to users.\n
            - Generate a testnet XRPL account to receive $evernode hosting rewards.\n
            \nContinue?" && exit 0
    
    check_sys_req
    $interactive && ! confirm "\nSystem check complete. Your system is capable of becoming an $evernode host. Make sure your system
            does not currently contain any other workloads important to you since we will be making modifications
            to your system configuration.
            \nThis is beta software, so there’s a chance things can go wrong. Continue?" && exit 0

    set_inet_addr
    echo "Using '$inetaddr' as host internet address."

    set_country_code
    echo "Using '$countrycode' as country code."

    set_cgrules_svc
    echo "Using '$cgrulessvc' as cgrules engine service."

    set_instance_alloc
    echo "Using allocation $(GB $alloc_ramKB) RAM, $(GB $alloc_swapKB) Swap, $(GB $alloc_diskKB) disk space, $alloc_instcount contract instances."
    
fi
