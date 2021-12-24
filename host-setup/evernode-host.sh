#!/bin/bash
# Evernode host setup tool to manage Sashimono installation and host registration.

evernode="Evernode beta"
sashimono_data="/etc/sashimono"
mb_data="$sashimono_data_dir/mb-xrpl"
maxmind_creds="653000:0yB7wwsBqCiPO2m6"

[ "$1" == "-q" ] && interactive=false || interactive=true
[ -f $sashimono_data/sa.cfg ] && sashimono_installed=true || sashimono_installed=false
[ -f $mb_data/mb-xrpl.cfg ] && mb_installed=true || mb_installed=false

inetaddr=$2 # Can be IP or DNS address
countrycode=$3 # 2-letter country code

function confirm() {
    echo -en $1" [y/n] "
    local yn=""
    read yn
    echo "" # Insert new line after answering.
    [[ $yn =~ ^[Yy]$ ]] && return 0 || return 1  # 0 means success.
}

function check_sys_req() {

    [ "$SKIP_SYSREQ" == "1" ] && return 0

    local proc1=$(ps --no-headers -o comm 1)
    if [ "$proc1" != "systemd" ]; then
        echo "$evernode host installation requires systemd. Your system does not have systemd running. Aborting."
        exit 0
    fi

    local os=$(grep -ioP '^ID=\K.+' /etc/os-release)
    local osversion=$(grep -ioP '^VERSION_ID=\K.+' /etc/os-release)

    local ramKB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    local diskKB=$(df | grep -w /home | head -1 | awk '{print $4}')
    [ -z "$diskKB" ] && diskKB=$(df | grep -w / | head -1 | awk '{print $4}')

    if [ "$os" != "ubuntu" ] || [ "$osversion" != '"20.04"' ] || [ $ramKB -lt 2000000 ] || [ $diskKB -lt 4194304 ]; then
        echo -e "Your system specs are:
            OS: $os $osversion
            RAM: $(bc <<<"scale=2; $ramKB / 1048576") GB
            Disk space (/home): $(bc <<<"scale=2; $diskKB / 1048576") GB"
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

echo "Thank you for trying out $evernode!"
if ! $sashimono_installed ; then

    $interactive && (confirm "This will install Sashimono, Evernode's contract instance management software,
            and register your system as an $evernode host on the public XRPL hooks testnet.\n
            \nThe setup will go through the following steps:\n
            - Check your system compatibility for $evernode.\n
            - Collect information about your system to be published to users.\n
            - Generate a testnet XRPL account to receive $evernode hosting rewards.\n
            \nContinue?" || exit 0)
    
    check_sys_req
    $interactive && (confirm "\nSystem check complete. Your system is capable of becoming an $evernode host. Make sure your system
            does not currently contain any other workloads important to you since we will be making modifications
            to your system configuration.
            \nThis is beta software, so there’s a chance things can go wrong. Continue?" || exit 0)

    set_inet_addr
    echo "Using '$inetaddr' as host internet address."

    set_country_code
    echo "Using '$countrycode' as country code."
fi
