#!/bin/bash
# Evernode host setup tool to manage Sashimono installation and host registration.

evernode="Evernode beta"
sashimono_data="/etc/sashimono"
mb_data="$sashimono_data_dir/mb-xrpl"

[ "$1" == "-q" ] && quiet=true || quiet=false
[ -f $sashimono_data/sa.cfg ] && sashimono_installed=true || sashimono_installed=false
[ -f $mb_data/mb-xrpl.cfg ] && mb_installed=true || mb_installed=false

function confirm() {
    echo -en $1" [y/n] "
    read -n 1 yn
    echo "" # Insert new line after answering.
    [[ $yn =~ ^[Yy]$ ]] && return 0 || return 1
}

function check_sys_req() {
    os=$(grep -ioP '^ID=\K.+' /etc/os-release)
    osversion=$(grep -ioP '^VERSION_ID=\K.+' /etc/os-release)

    ramKB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    diskKB=$(df | grep -w /home | head -1 | awk '{print $4}')
    [ -z "$diskKB" ] && diskKB=$(df | grep -w / | head -1 | awk '{print $4}')

    if [ "$os" != "ubuntu" ] || [ "$osversion" != '"20.04"' ] || [ $ramKB -lt 2000000 ] || [ $diskKB -lt 4194304 ]; then
        echo -e "Your system specs are:
            OS: $os $osversion
            RAM: $(bc <<<"scale=2; $ramKB / 1048576") GB
            Disk space (/home): $(bc <<<"scale=2; $diskKB / 1048576") GB"
        echo "$evernode host registration requires Ubuntu 20.04 with 2GB RAM and 4GB free disk space for /home. Your system does not meet some of the requirements. Aborting."
        exit 0
    fi
}

echo "Thank you for trying out $evernode!"
if ! $sashimono_installed ; then
    if ! $quiet ; then
        confirm "This will install Sashimono, Evernode's contract instance management software,
                and register your system as an $evernode host on the public XRPL hooks testnet.\n
                \nThe setup will go through the following steps:\n
                - Check your system compatibility for $evernode.\n
                - Collect information about your system to be published to users.\n
                - Generate a testnet XRPL account to receive $evernode hosting rewards.\n
                \nContinue?" || exit 0
    fi
    
    check_sys_req
fi
