#!/bin/bash
# Sashimono cluster management script.

# Usage examples:
# ./cluster.sh select contract
# ./cluster.sh create 1
# ./cluster.sh create
# ./cluster.sh reconfig
# ./cluster.sh reconfig R
# ./cluster.sh reconfig 1 R
# ./cluster.sh lcl
# ./cluster.sh lcl 1

# Command modes:
# select - Sets the currently active contract from the list of contracts defined in config.json file.
# reconfig - Re configure the sashimono with given "max_instance_count" in all the hosts (Only update the sa.cfg, Reinstall the sashimono if "R" option is given).
# lcl - Get lcl of the hosts.
# create - Create new sashimono hotpocket instance in each node.
# get-unl - Construct the UNL of all the nodes (Useful when creating cfg for contract upload).
# docker-pull - Pull the latest docker image from docker hub.
# start - Start sashimono hotpocket instance.
# stop - Stop sashimono hotpocket instance.
# destroy - Destroy sashimono hotpocket instance.

LOCKFILE="/tmp/sashiclusercfg.lock"
trap "rm -f $LOCKFILE" EXIT

PRINTFORMAT="Node %2s: %s\n"

mode=$1

if [ "$mode" == "select" ] || [ "$mode" == "reconfig" ] || [ "$mode" == "lcl" ] || [ "$mode" == "get-unl" ] || [ "$mode" == "docker-pull" ] || [ "$mode" == "create" ] || [ "$mode" == "start" ] || [ "$mode" == "stop" ] || [ "$mode" == "destroy" ]; then
    echo "mode: $mode"
else
    echo "Invalid command."
    echo " Expected: select <contract name> | reconfig [N] [R] | lcl [N] | get-unl | docker-pull [N] | create [N] | start [N] | stop [N] | destroy [N]"
    echo " [N]: Optional node no.   [R]: 'R' If sashimono needed to reinstall."
    exit 1
fi

# jq command is used for json manipulation.
if ! command -v jq &>/dev/null; then
    sudo apt-get install -y jq
fi

configfile=config.json
if [ ! -f $configfile ]; then
    # Create default config file.
    echo '{"selected":"contract","contracts":[{"name":"contract","sshuser":"root","sshpass":"<ssh password>","owner_pubkey":"ed.....","contract_id":"<uuid>","docker":{"image":"<docker image key>","id":"","pass":""},"vultr_group":"","hosts":{"host1_ip":{}},"config":{},"sa_config":{"max_instance_count":-1}}],"vultr":{"api_key":"<vultr api key>"}}' | jq . >$configfile
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
    alias sshskp="sshpass -p $sshpass ssh -o StrictHostKeychecking=no"
fi

function updateconfig() {
    # Update config using locking mechanism since update can be hapenned by multiple pocesses.
    cmd="$1 $configfile >$configfile.tmp && mv $configfile.tmp $configfile"
    flock -x $LOCKFILE -c "$cmd"
}

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
    updateconfig "jq '(.contracts[] | select(.name == \"$selectedcont\") | .hosts) |= $hosts'"
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

if [ $mode == "reconfig" ]; then
    # If node if is specified take 3rd arg otherwise take 2nd.
    if [ $nodeid = -1 ]; then
        reinstall=$2
    else
        reinstall=$3
    fi

    # If reinstall specified, show warn and take confirmation.
    if [ ! -z $reinstall ] && [ $reinstall == "R" ]; then
        echo "Warning: you'll lost all the sashimono instances!"
        echo "Still are you sure you want to reinstall Sashimono?"
        read -p "Type 'yes' to confirm reinstall: " confirmation </dev/tty
        [ "$confirmation" != "yes" ] && echo "Reinstall cancelled." && exit 0
    fi

    max_instance_count=$(echo $continfo | jq -r '.sa_config.max_instance_count')
    if ! [[ $max_instance_count =~ ^[0-9]+$ ]]; then
        max_instance_count=-1
    fi

    cgrulesengd_service="cgrulesengdsvc"
    sashimono_service="sashimono-agent"
    saconfig="/etc/sashimono/sa.cfg"

    uninstall="curl -fsSL https://sthotpocket.blob.core.windows.net/sashimono/uninstall.sh | bash -s -- -q"
    install="curl -fsSL https://sthotpocket.blob.core.windows.net/sashimono/install.sh | bash -s -- -q"

    restartcgrs="systemctl restart $cgrulesengd_service.service"
    restartsas="systemctl restart $sashimono_service.service"

    # Re configure sashimono for given host.
    function reconfig() {
        hostaddr=${hostaddrs[$1]}
        nodeno=$(expr $1 + 1)
        changecfg="jq '.hp.host_address = \"$hostaddr\"' $saconfig >$saconfig.tmp && mv $saconfig.tmp $saconfig"
        if [ $max_instance_count != -1 ]; then
            changecfg+=" && jq '.system.max_instance_count = $max_instance_count' $saconfig >$saconfig.tmp && mv $saconfig.tmp $saconfig"
        fi

        # Reinstall sashimono only if reinstall specified.
        if [ ! -z $reinstall ] && [ $reinstall == "R" ]; then
            command="$uninstall && $install && $changecfg && $restartcgrs && $restartsas"
        else
            command="$changecfg && $restartsas"
        fi

        if ! sshskp $sshuser@$hostaddr $command &>/dev/null; then
            printf "$PRINTFORMAT" "$nodeno" "Error occured reconfiguring sashimono."
        else
            # Remove host info if reinstall.
            if [ ! -z $reinstall ] && [ $reinstall == "R" ]; then
                updateconfig "jq '(.contracts[] | select(.name == \"$selectedcont\") | .hosts.\"$hostaddr\") |= {}'"
            fi
            printf "$PRINTFORMAT" "$nodeno" "Successfully reconfigured sashimono."
        fi
    }

    if [ $nodeid = -1 ]; then
        for i in "${!hostaddrs[@]}"; do
            reconfig $i &
        done
        wait
    else
        reconfig $nodeid
    fi
    exit 0
fi

if [ $mode == "lcl" ]; then
    # Get lcl for given host.
    function getlcl() {
        hostaddr=${hostaddrs[$1]}
        nodeno=$(expr $1 + 1)
        containername=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".name")

        if [ "$containername" == "" ] || [ "$containername" == "null" ]; then
            printf "$PRINTFORMAT" "$nodeno" "Host info is empty."
            exit 1
        fi

        cpath="contdir=\$(find / -type d -path '/home/sashi*/$containername' 2>/dev/null) || [ ! -z \$contdir ]"
        msno="max_shard_no=\$(ls -v \$contdir/ledger_fs/seed/primary/ | tail -2 | head -1)"
        lcl="[ ! -z \$max_shard_no ] && echo \"select seq_no || '-' || lower(hex(ledger_hash)) from ledger order by seq_no DESC limit 1;\" | sqlite3 file:\$contdir/ledger_fs/seed/primary/\$max_shard_no/ledger.sqlite?mode=ro"
        command="$cpath && $msno && $lcl"
        output=$(sshskp $sshuser@$hostaddr $command 2>&1 | tr '\0' '\n')
        printf "$PRINTFORMAT" "$nodeno" "$output"
    }

    if [ $nodeid = -1 ]; then
        for i in "${!hostaddrs[@]}"; do
            getlcl $i &
        done
        wait
    else
        getlcl $nodeid
    fi
    exit 0
fi

if [ $mode == "docker-pull" ]; then
    dockerbin=/usr/bin/sashimono-agent/dockerbin/docker
    dockerrepo="hotpocketdev/sashimono:"
    # Read the image.
    image=$(echo $continfo | jq -r '.docker.image')
    if [ "$image" == "" ] || [ "$image" == "null" ]; then
        echo "image not specified."
        exit 1
    fi

    # Read docker credentials.
    dockerid=$(echo $continfo | jq -r '.docker.id')
    dockerpass=$(echo $continfo | jq -r '.docker.pass')
    dockerpull="$dockerbin pull $dockerrepo$image"
    # If credentials given.
    if [ "$dockerid" != "" ] && [ "$dockerid" != "null" ] && [ "$dockerpass" != "" ] && [ "$dockerpass" != "null" ]; then
        dockerpull="(echo $dockerpass | $dockerbin login -u $dockerid --password-stdin &>/dev/null) && $dockerpull && $dockerbin logout"
    fi

    # Docker pull for given host.
    function dockerpull() {
        hostaddr=${hostaddrs[$1]}
        nodeno=$(expr $1 + 1)
        containername=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".name")

        if [ "$containername" == "" ] || [ "$containername" == "null" ]; then
            printf "$PRINTFORMAT" "$nodeno" "Host info is empty."
            exit 1
        fi

        user="user=\$(find / -type d -path '/home/sashi*/$containername' 2>/dev/null | cut -d/ -f3) || [ ! -z \$user ]"
        dpull="sudo -H -u \$user DOCKER_HOST=\"unix:///run/user/\$(id -u \$user)/docker.sock\" bash -c \"$dockerpull\""
        command="$user && $dpull"
        if ! sshskp $sshuser@$hostaddr $command 1>/dev/null; then
            printf "$PRINTFORMAT" "$nodeno" "Error occured pulling $image."
        else
            printf "$PRINTFORMAT" "$nodeno" "Successfully pulled $image."
        fi
    }

    if [ $nodeid = -1 ]; then
        for i in "${!hostaddrs[@]}"; do
            dockerpull $i &
        done
        wait
    else
        dockerpull $nodeid
    fi
    exit 0
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

    image=$(echo $continfo | jq -r '.docker.image')
    if [ "$image" == "" ] || [ "$image" == "null" ]; then
        echo "image not specified."
        exit 1
    fi

    # Create an instance for given host.
    function createinstance() {
        hostaddr=${hostaddrs[$1]}
        nodeno=$(expr $1 + 1)
        # If host info is already populated, skip instance creation.
        containername=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".name")
        if [ "$containername" == "" ] || [ "$containername" == "null" ]; then
            if [ "$1" != 0 ]; then
                hostinfo=$(echo $continfo | jq -r ".hosts.\"${hostaddrs[0]}\"")
                pubkey=$(echo $hostinfo | jq -r '.pubkey')
            fi

            config=$(echo $continfo | jq -c -r ".config")
            if [ "$1" != 0 ]; then
                peers=""
                # for ((i = 0; i < $1; i++)); do
                #     hostinfo=$(echo $continfo | jq -r ".hosts.\"${hostaddrs[$i]}\"")
                #     peerport=$(echo $hostinfo | jq -r '.peer_port')

                #     if [ "$hostinfo" == "" ] || [ "$hostinfo" == "null" ] ||
                #         [ "$peerport" == "" ] || [ "$peerport" == "null" ]; then
                #         echo "Host info is empty for ${hostaddrs[$i]}"
                #         exit 1
                #     fi
                #     peers+="\"${hostaddrs[$i]}:$peerport\","
                # done
                # peers=${peers%?}

                # For all instances except the first, configure the first host's address as the peer for all.
                # We expect Hot Pocket peer discovery to populate all peers in all instances.
                peers=${hostaddrs[0]}
                config=$(echo "$config" | jq -c ".mesh.known_peers = [$peers]" | jq -c ".contract.unl = [\"$pubkey\"]")
            fi

            command="sashi json -m '{\"type\":\"create\",\"owner_pubkey\":\"$ownerpubkey\",\"contract_id\":\"$contractid\",\"image\":\"$image\",\"config\":$config}'"
            output=$(sshskp $sshuser@$hostaddr $command | tr '\0' '\n')
            # If an output received consider updating the json file.
            if [ ! "$output" = "" ]; then
                content=$(echo $output | jq -r '.content')
                printf "$PRINTFORMAT" "$nodeno" "$output"
                # Update the json if no error.
                if [ ! "$content" == "" ] && [ ! "$content" == "null" ] && [[ ! "$content" =~ ^[a-zA-Z]+_error$ ]]; then
                    updateconfig "jq '(.contracts[] | select(.name == \"$selectedcont\") | .hosts.\"$hostaddr\") |= $content'"
                    # Refresh the in-memory config to include latest node creation details.
                    continfo=$(jq -r ".contracts[] | select(.name == \"$selectedcont\")" $configfile)
                    hosts=$(echo $continfo | jq -r '.hosts')
                    hostaddrs=($(echo $hosts | jq -r 'keys_unsorted[]'))
                fi
            else
                printf "$PRINTFORMAT" "$nodeno" "Instance creation error."
            fi
        else
            printf "$PRINTFORMAT" "$nodeno" "Instance is already created."
        fi
    }

    if [ $nodeid = -1 ]; then
        for i in "${!hostaddrs[@]}"; do
            createinstance $i &
        done
        wait
    else
        createinstance $nodeid
    fi
    exit 0
fi

if [ $mode == "get-unl" ]; then
    unl=""
    for hostaddr in "${hostaddrs[@]}"; do
        hostinfo=$(echo $continfo | jq -r ".hosts.\"$hostaddr\"")
        pubkey=$(echo $hostinfo | jq -r '.pubkey')

        if [ "$hostinfo" == "" ] || [ "$hostinfo" == "null" ] ||
            [ "$pubkey" == "" ] || [ "$pubkey" == "null" ]; then
            echo "Host pubkey is empty for $hostaddr"
            exit 1
        fi
        unl+="\"$pubkey\","
    done

    # Remove trainling comma(,) and add square brackets for the lists.
    unl=${unl%?}
    echo "{\"unl\":[$unl]}" | jq .
    exit 0
fi

# if [ $mode == "initiate" ]; then
#     # Initiate the instance of given host.
#     function initiateinstance() {
#         hostaddr=${hostaddrs[$1]}
#         nodeno=$(expr $1 + 1)
#         peers=$2
#         unl=$3
#         config=$(echo $continfo | jq -r ".config")
#         containername=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".name")
#         peerport=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".peer_port")
#         selfpeer="\"$hostaddr:$peerport\""
#         # Remove self peer from the peers.
#         updatedpeers=$(echo $peers | sed "s/\($selfpeer,\|,$selfpeer\|$selfpeer\)//g")
#         # Update the in memory config with received peers and unl.
#         updatedconfig=$(echo $config | jq ".mesh.known_peers = [$updatedpeers]" | jq ".contract.unl = [$unl]")
#         command="sashi json -m '{\"type\":\"initiate\",\"container_name\":\"$containername\",\"config\":$updatedconfig}'"
#         output=$(sshskp $sshuser@$hostaddr $command 2>&1 | tr '\0' '\n')
#         printf "$PRINTFORMAT" "$nodeno" "$output"
#     }

#     # Read each hosts config and construct cluster unl and peers.
#     peers=""
#     unl=""
#     for hostaddr in "${hostaddrs[@]}"; do
#         hostinfo=$(echo $continfo | jq -r ".hosts.\"$hostaddr\"")
#         pubkey=$(echo $hostinfo | jq -r '.pubkey')
#         ip=$(echo $hostinfo | jq -r '.ip')
#         peerport=$(echo $hostinfo | jq -r '.peer_port')

#         if [ "$hostinfo" == "" ] || [ "$hostinfo" == "null" ] ||
#             [ "$pubkey" == "" ] || [ "$pubkey" == "null" ] ||
#             [ "$ip" == "" ] || [ "$ip" == "null" ] ||
#             [ "$peerport" == "" ] || [ "$peerport" == "null" ]; then
#             echo "Host info is empty for $hostaddr"
#             exit 1
#         fi
#         peers+="\"$hostaddr:$peerport\","
#         unl+="\"$pubkey\","
#     done

#     # Remove trainling comma(,) and add square brackets for the lists.
#     peers=${peers%?}
#     unl=${unl%?}

#     if [ $nodeid = -1 ]; then
#         for i in "${!hostaddrs[@]}"; do
#             initiateinstance $i $peers $unl &
#         done
#         wait
#     else
#         initiateinstance $nodeid $peers $unl
#     fi
#     exit 0
# fi

if [ $mode == "start" ]; then
    # Start instance of given host.
    function startinstance() {
        hostaddr=${hostaddrs[$1]}
        nodeno=$(expr $1 + 1)
        containername=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".name")
        command="sashi json -m '{\"type\":\"start\",\"container_name\":\"$containername\"}'"
        output=$(sshskp $sshuser@$hostaddr $command 2>&1 | tr '\0' '\n')
        printf "$PRINTFORMAT" "$nodeno" "$output"
    }

    if [ $nodeid = -1 ]; then
        for i in "${!hostaddrs[@]}"; do
            startinstance $i &
        done
        wait
    else
        startinstance $nodeid
    fi
    exit 0
fi

if [ $mode == "stop" ]; then
    # Stop instance of given host.
    function stopinstance() {
        hostaddr=${hostaddrs[$1]}
        nodeno=$(expr $1 + 1)
        containername=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".name")
        command="sashi json -m '{\"type\":\"stop\",\"container_name\":\"$containername\"}'"
        output=$(sshskp $sshuser@$hostaddr $command 2>&1 | tr '\0' '\n')
        printf "$PRINTFORMAT" "$nodeno" "$output"
    }

    if [ $nodeid = -1 ]; then
        for i in "${!hostaddrs[@]}"; do
            stopinstance $i &
        done
        wait
    else
        stopinstance $nodeid
    fi
    exit 0
fi

if [ $mode == "destroy" ]; then
    # Destroy instance of given host.
    function destroyinstance() {
        hostaddr=${hostaddrs[$1]}
        nodeno=$(expr $1 + 1)
        containername=$(echo $continfo | jq -r ".hosts.\"$hostaddr\".name")
        command="sashi json -m '{\"type\":\"destroy\",\"container_name\":\"$containername\"}'"
        output=$(sshskp $sshuser@$hostaddr $command | tr '\0' '\n')
        # If an output received consider updating the json file.
        if [ ! "$output" = "" ]; then
            content=$(echo $output | jq -r '.content')
            printf "$PRINTFORMAT" "$nodeno" "$output"
            # Update the json if no error.
            if [ ! "$content" == "" ] && [ ! "$content" == "null" ] && [[ ! "$content" =~ ^[a-zA-Z]+_error$ ]]; then
                # If a vultr group is defined remove self ip from the hosts.
                if [ "$vultrgroup" != "" ] && [ "$vultrgroup" != "null" ]; then
                    updateconfig "jq '(.contracts[] | select(.name == \"$selectedcont\") | .hosts) |= del(.\"$hostaddr\")'"
                else
                    updateconfig "jq '(.contracts[] | select(.name == \"$selectedcont\") | .hosts.\"$hostaddr\") |= {}'"
                fi
            fi
        else
            printf "$PRINTFORMAT" "$nodeno" "Instance destroy error."
        fi
    }

    if [ $nodeid = -1 ]; then
        for i in "${!hostaddrs[@]}"; do
            destroyinstance $i &
        done
        wait
    else
        destroyinstance $nodeid
    fi
    exit 0
fi
