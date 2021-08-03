#!/bin/bash
# Sashimono cluster management script.

# Usage examples:
# ./cluster.sh select contract
# ./cluster.sh create 1
# ./cluster.sh create

# Command modes:
# select - Sets the currently active contract from the list of contracts defined in config.json file.
# create - Create new sashimono hotpocket instance in each node.
# initiate - Initiate sashimono hotpocket instance with configs.
# start - Start sashimono hotpocket instance.
# stop - Stop sashimono hotpocket instance.
# destroy - Destroy sashimono hotpocket instance.

mode=$1

if [ "$mode" == "select" ] || [ "$mode" == "create" ] || [ "$mode" == "initiate" ] || [ "$mode" == "start" ] || [ "$mode" == "stop" ] || [ "$mode" == "destroy" ]; then
    echo "mode: $mode"
else
    echo "Invalid command."
    echo " Expected: select <contract name> | create [N] | initiate [N] | start [N] | stop [N] | destroy [N]"
    echo " <N>: Required node no.   [N]: Optional node no."
    exit 1
fi

# jq command is used for json manipulation.
if ! command -v jq &>/dev/null; then
    sudo apt-get install -y jq
fi

configfile=config.json
if [ ! -f $configfile ]; then
    # Create default config file.
    echo '{"selected":"contract","contracts":[{"name":"contract","sshuser":"root","sshpass":"<ssh password>","owner_pubkey":"ed.....","contract_id":"<uuid>","image":"<docker image key>","vultr_group":"<vultr group name>","hosts":{"host1_ip":{}},"config":{}}], "vultr":{"api_key":"<vultr api key>"}}' | jq . >$configfile
fi

if [ $mode == "select" ]; then
    selectedcont=$2
    if [ "$selectedcont" == "" ] || [ "$selectedcont" == "null" ]; then
        echo "Please specify contract name to select."
        exit 1
    fi
    continfo=$(jq -r ".contracts[] | select(.name == \"$selectedcont\")" $configfile)
    if [ "$continfo" == "" ] || [ "$continfo" == "null" ]; then
        echo "No configuration found for selected contract '"$selectedcont"'"
        exit 1
    fi

    # Set the 'selected' field value on cluster config file.
    jq ".selected = \"$selectedcont\"" $configfile >$configfile.tmp && mv $configfile.tmp $configfile
    echo "Selected '"$selectedcont"'"
    exit 0
fi

selectedcont=$(jq -r '.selected' $configfile)
if [ "$selectedcont" == "" ] || [ "$selectedcont" == "null" ]; then
    echo "No contract selected."
    exit 1
fi

continfo=$(jq -r ".contracts[] | select(.name == \"$selectedcont\")" $configfile)
if [ "$continfo" == "" ] || [ "$continfo" == "null" ]; then
    echo "No configuration found for selected contract '"$selectedcont"'"
    exit 1
fi

# Read ssh user and password and set contract directory based on username.
sshuser=$(echo $continfo | jq -r '.sshuser')
sshpass=$(echo $continfo | jq -r '.sshpass')
if [ "$sshuser" == "" ] || [ "$sshuser" == "null" ]; then
    echo "sshuser not specified."
    exit 1
fi

shopt -s expand_aliases
alias sshskp='ssh -o StrictHostKeychecking=no'
if [ "$sshpass" != "" ] && [ "$sshpass" != "null" ]; then
    alias sshskp='sshpass -p $sshpass ssh -o StrictHostKeychecking=no'
fi

hosts=$(echo $continfo | jq -r '.hosts')

vultrgroup=$(echo $continfo | jq -r '.vultr_group')
# Read from vultr group only if group name is given and hosts are empty.
if [ "$vultrgroup" != "" ] && [ "$vultrgroup" != "null" ] && ([ "$hosts" = "" ] || [ "$hosts" = "{}" ]); then
    # Call Vultr rest api GET. (params: endpoint, apikey)
    function vultrget() {
        local _result=$(curl --silent "https://api.vultr.com/v2/$1" -X GET -H "Authorization: Bearer $2" -H "Content-Type: application/json" -w "\n%{http_code}")
        local _parts
        readarray -t _parts < <(printf '%s' "$_result")  # break parts by new line.
        if [[ ${_parts[1]} == 2* ]]; then                # Check for 2xx status code.
            [ ! -z "${_parts[0]}" ] && echo ${_parts[0]} # Return api output if there is any.
        else
            echo >&2 "Error on vultrget code:${_parts[1]} body:${_parts[0]}" && exit 1
        fi
    }

    vultrapikey=$(jq -r ".vultr.api_key" $configfile)
    [ -z $vultrapikey ] && echo >&2 "Vultr api key not found." && exit 1
    vultrvms=$(vultrget "instances?tag=${vultrgroup}" "$vultrapikey")
    [ -z "$vultrvms" ] && exit 1
    vultrips=$(echo $(echo $vultrvms | jq -r ".instances | sort_by(.label) | .[] | .main_ip"))
    readarray -d " " -t hostaddrs < <(printf '%s' "$vultrips") # Populate hostaddrs with ips retrieved from vultr.

    # Update json file's hosts section
    hosts=$(printf '%s\n' "${hostaddrs[@]}" | jq -R . | jq -s . | jq -r 'map({(.): {}}) | add')
    jq "(.contracts[] | select(.name == \"$selectedcont\") | .hosts) |= $hosts" $configfile >$configfile.tmp && mv $configfile.tmp $configfile
    echo "Retrieved ${#hostaddrs[@]} host addresses from vultr group: '$vultrgroup'"
elif [ "$hosts" != "" ] && [ "$hosts" != "{}" ]; then
    hostaddrs=($(echo $hosts | jq -r 'keys_unsorted[]'))
else
    echo "Please provide a vultr_group or list of hosts"
    exit 1
fi

# Check if second arg (nodeid) is a number or not.
# If it's a number then reduce 1 from it to get zero-based node index.
if ! [[ $2 =~ ^[0-9]+$ ]]; then
    let nodeid=-1
else
    let nodeid=$2-1
fi

if [ $mode == "create" ]; then
    # Read owner pubkey, contract id and image
    ownerpubkey=$(echo $continfo | jq -r '.owner_pubkey')
    if [ "$ownerpubkey" = "" ] || [ "$ownerpubkey" = "null" ]; then
        echo "owner_pubkey not specified."
        exit 1
    fi

    contractid=$(echo $continfo | jq -r '.contract_id')
    if [ "$contractid" == "" ] || [ "$contractid" == "null" ]; then
        echo "contract_id not specified."
        exit 1
    fi

    image=$(echo $continfo | jq -r '.image')
    if [ "$image" == "" ] || [ "$image" == "null" ]; then
        echo "image not specified."
        exit 1
    fi

    # Create an instance for given host.
    function createinstance() {
        hostaddr=$1
        # If host info is already populated, skip instance creation.
        containername=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".name")
        if [ "$containername" == "" ] || [ "$containername" == "null" ]; then
            command="sashi json -m '{\"type\":\"create\",\"owner_pubkey\":\"$ownerpubkey\",\"contract_id\":\"$contractid\",\"image\":\"$image\"}'"
            output=$(sshskp $sshuser@$hostaddr $command | tr '\0' '\n')
            # If an output received consider updating the json file.
            if [ ! "$output" = "" ]; then
                content=$(echo $output | jq -r '.content')
                echo $output
                # Update the json if no error.
                if [ ! "$content" == "" ] && [ ! "$content" == "null" ] && [[ ! "$content" =~ ^[a-zA-Z]+_error$ ]]; then
                    jq "(.contracts[] | select(.name == \"$selectedcont\") | .hosts.\"$hostaddr\") |= $content" $configfile >$configfile.tmp && mv $configfile.tmp $configfile
                fi
            fi
        else
            echo "Instance is already created for $hostaddr"
        fi
    }

    if [ $nodeid = -1 ]; then
        for hostaddr in "${hostaddrs[@]}"; do
            createinstance $hostaddr &
        done
        wait
    else
        hostaddr=${hostaddrs[$nodeid]}
        createinstance $hostaddr
    fi
    exit 0
fi

if [ $mode == "initiate" ]; then
    # Initiate the instance of given host.
    function initiateinstance() {
        hostaddr=$1
        peers=$2
        unl=$3
        config=$(echo $continfo | jq -r ".config")
        containername=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".name")
        peerport=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".peer_port")
        selfpeer="\"$hostaddr:$peerport\""
        # Remove self peer from the peers.
        updatedpeers=$(echo $peers | sed "s/\($selfpeer,\|,$selfpeer\|$selfpeer\)//g")
        # Update the in memory config with received peers and unl.
        updatedconfig=$(echo $config | jq ".mesh.known_peers = $updatedpeers" | jq ".contract.unl = $unl")
        command="sashi json -m '{\"type\":\"initiate\",\"container_name\":\"$containername\",\"config\":$updatedconfig}'"
        sshskp $sshuser@$hostaddr $command
    }

    # Read each hosts config and construct cluster unl and peers.
    peers=""
    unl=""
    for hostaddr in "${hostaddrs[@]}"; do
        hostinfo=$(echo $continfo | jq -r ".hosts.\"$hostaddr\"")
        pubkey=$(echo $hostinfo | jq -r '.pubkey')
        ip=$(echo $hostinfo | jq -r '.ip')
        peerport=$(echo $hostinfo | jq -r '.peer_port')

        if [ "$hostinfo" == "" ] || [ "$hostinfo" == "null" ] ||
            [ "$pubkey" == "" ] || [ "$pubkey" == "null" ] ||
            [ "$ip" == "" ] || [ "$ip" == "null" ] ||
            [ "$peerport" == "" ] || [ "$peerport" == "null" ]; then
            echo "Host info is empty for $hostaddr"
            exit 1
        fi
        peers+="\"$hostaddr:$peerport\","
        unl+="\"$pubkey\","
    done

    # Remove trainling comma(,) and add square brackets for the lists.
    peers="[${peers%?}]"
    unl="[${unl%?}]"

    if [ $nodeid = -1 ]; then
        for hostaddr in "${hostaddrs[@]}"; do
            initiateinstance $hostaddr $peers $unl &
        done
        wait
    else
        hostaddr=${hostaddrs[$nodeid]}
        initiateinstance $hostaddr $peers $unl
    fi
    exit 0
fi

if [ $mode == "start" ]; then
    # Start instance of given host.
    function startinstance() {
        hostaddr=$1
        containername=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".name")
        command="sashi json -m '{\"type\":\"start\",\"container_name\":\"$containername\"}'"
        sshskp $sshuser@$hostaddr $command
    }

    if [ $nodeid = -1 ]; then
        for hostaddr in "${hostaddrs[@]}"; do
            startinstance $hostaddr &
        done
        wait
    else
        hostaddr=${hostaddrs[$nodeid]}
        startinstance $hostaddr
    fi
    exit 0
fi

if [ $mode == "stop" ]; then
    # Stop instance of given host.
    function stopinstance() {
        hostaddr=$1
        containername=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".name")
        command="sashi json -m '{\"type\":\"stop\",\"container_name\":\"$containername\"}'"
        sshskp $sshuser@$hostaddr $command
    }

    if [ $nodeid = -1 ]; then
        for hostaddr in "${hostaddrs[@]}"; do
            stopinstance $hostaddr &
        done
        wait
    else
        hostaddr=${hostaddrs[$nodeid]}
        stopinstance $hostaddr
    fi
    exit 0
fi

if [ $mode == "destroy" ]; then
    # Destroy instance of given host.
    function destroyinstance() {
        hostaddr=$1
        containername=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".name")
        command="sashi json -m '{\"type\":\"destroy\",\"container_name\":\"$containername\"}'"
        output=$(sshskp $sshuser@$hostaddr $command | tr '\0' '\n')
        # If an output received consider updating the json file.
        if [ ! "$output" = "" ]; then
            content=$(echo $output | jq -r '.content')
            echo $output
            # Update the json if no error.
            if [ ! "$content" == "" ] && [ ! "$content" == "null" ] && [[ ! "$content" =~ ^[a-zA-Z]+_error$ ]]; then
                # If a vultr group is defined remove self ip from the hosts.
                if [ "$vultrgroup" != "" ] && [ "$vultrgroup" != "null" ]; then
                    jq "(.contracts[] | select(.name == \"$selectedcont\") | .hosts) |= del(.\"$hostaddr\")" $configfile >$configfile.tmp && mv $configfile.tmp $configfile
                else
                    jq "(.contracts[] | select(.name == \"$selectedcont\") | .hosts.\"$hostaddr\") |= {}" $configfile >$configfile.tmp && mv $configfile.tmp $configfile
                fi
            fi
        fi
    }

    if [ $nodeid = -1 ]; then
        for hostaddr in "${hostaddrs[@]}"; do
            destroyinstance $hostaddr &
        done
        wait
    else
        hostaddr=${hostaddrs[$nodeid]}
        destroyinstance $hostaddr
    fi
    exit 0
fi
