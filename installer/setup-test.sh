#!/bin/bash
# Evernode host setup tool to manage Sashimono installation and host registration.
# This script is also used as the 'evernode' cli alias after the installation.
# usage: ./setup.sh install

# surrounding braces  are needed make the whole script to be buffered on client before execution.
{
    export SASHIMONO_DATA="/home/chalith/Workspace/HotpocketDev/sashimono"
    export SASHIMONO_CONFIG="$SASHIMONO_DATA/sa.cfg"
    export MB_XRPL_DATA="$SASHIMONO_DATA/mb-xrpl"
    export MB_XRPL_CONFIG="$MB_XRPL_DATA/mb-xrpl.cfg"
    export PUBLIC_CONFIG="$MB_XRPL_DATA/configuration.json"
    export NODEJS_BIN="/usr/bin/node"
    export SETUP_HELPER="/home/chalith/Workspace/HotpocketDev/sashimono/installer"
    export JS_HELPER="$SETUP_HELPER/jshelper/index.js"
    export MIN_OPERATIONAL_COST_PER_MONTH=5
    # 3 Month minimum operational duration is considered.
    export MIN_OPERATIONAL_DURATION=3

    mb_cli_exit_err="MB_CLI_EXITED"
    mb_cli_out_prefix="CLI_OUT"
    multi_choice_result=""

    public_config_url="https://raw.githubusercontent.com/EvernodeXRPL/evernode-resources/main/definitions/definitions.json"

    country_code="AU"
    cpu_micro_sec=""
    ram_kb=""
    swap_kb=""
    disk_kb=""
    total_instance_count=""
    cpu_model="test"
    cpu_count=4
    cpu_speed=5
    email_address="test@gmail.com"
    description="test"

    # We execute some commands as unprivileged user for better security.
    # (we execute as the user who launched this script as sudo)
    noroot_user=${SUDO_USER:-$(whoami)}

    inetaddr=""
    xrpl_address=""
    xrpl_secret_path=""
    xrpl_secret=""
    rippled_server=""

    export NETWORK="${NETWORK:-mainnet}"

    function rollback() {
        echo "Rollbacking the instalation.."
        burn_leases
        check_and_deregister
        exit 1
    }

    function abort() {
        echo "Aborting the instalation.."
        exit 0
    }

    function spin() {
        while [ 1 ]; do
            for i in ${spinner[@]}; do
                echo -ne "\r$i"
                sleep 0.2
            done
        done
    }

    function wait_call() {
        local command_to_execute="$1"
        local output_template="$2"

        echomult "\nWaiting for the process to complete..."
        spin &
        local spin_pid=$!

        $command_to_execute
        return_code=$?

        kill $spin_pid
        wait $spin_pid
        echo -ne "\r"

        return $return_code
    }

    # Helper to print multi line text.
    # (When passed as a parameter, bash auto strips spaces and indentation which is what we want)
    function echomult() {
        echo -e $1
    }

    function confirm() {
        local prompt=$1
        local default_choice=${2:-y} #Default choice is set to 'y' if $2 parameter is not provided.

        local choice_display="[Y/n]"
        if [ "$default_choice" == "n" ]; then
            choice_display="[y/N]"
        fi

        echo -en "$prompt $choice_display "
        local yn=""
        read yn </dev/tty

        # Default choice is 'y'
        [ -z $yn ] && yn="$default_choice"
        while ! [[ $yn =~ ^[Yy|Nn]$ ]]; do
            read -ep "'y' or 'n' expected: " yn </dev/tty
        done

        echo ""                                     # Insert new line after answering.
        [[ $yn =~ ^[Yy]$ ]] && return 0 || return 1 # 0 means success.
    }

    function multi_choice() {
        local prompt=$1
        local choice_display=${2:-y/n}

        IFS='/'
        read -ra ADDR <<<"$choice_display"

        local default_choice=${3:-1} #Default choice is set to first.

        # Fallback to 1 if invalid.
        ([[ ! $default_choice =~ ^[0-9]+$ ]] || [[ $default_choice -lt 0 ]] || [[ $default_choice -gt ${#ADDR[@]} ]]) && default_choice=1

        echo -en "$prompt?\n"
        local i=1
        for choice in "${ADDR[@]}"; do
            [[ $default_choice -eq $i ]] && echo "($i) ${choice^^}" || echo "($i) $choice"
            i=$((i + 1))
        done

        local choice=""
        read choice </dev/tty

        [ -z $choice ] && choice="$default_choice"
        while ! ([[ $choice =~ ^[0-9]+$ ]] && [[ $choice -gt 0 ]] && [[ $choice -lt $i ]]); do
            read -ep "[1-$i] expected: " choice </dev/tty
            [ -z $choice ] && choice="$default_choice"
        done

        multi_choice_result="${ADDR[$((choice - 1))]}"
    }

    function multi_choice_output() {
        echo $multi_choice_result
    }

    function exec_jshelper() {
        # Create fifo file to read response data from the helper script.
        local resp_file=$SETUP_HELPER/helper_fifo
        [ -p $resp_file ] || sudo -u $noroot_user mkfifo $resp_file

        # Execute js helper asynchronously while collecting response to fifo file.
        sudo -u $noroot_user RESPFILE=$resp_file $NODEJS_BIN $JS_HELPER "$@" "network:$NETWORK" &
        local pid=$!
        local result=$(cat $resp_file) && [ "$result" != "-" ] && echo $result

        # Wait for js helper to exit and reflect the error exit code in this function return.
        wait $pid && [ $? -eq 0 ] && rm $resp_file && return 0
        rm $resp_file && return 1
    }

    # Function to generate QR code in the terminal
    function generate_qrcode() {
        if [ -z "$1" ]; then
            echo "Argument error > Usage: generate_qrcode <string>"
            return 1
        fi
        local input_string="$1"
        qrencode -s 1 -l L -t UTF8 "$input_string"
    }

    function read_configs() {
        local override_network=$(jq -r ".xrpl.network | select( . != null )" "$MB_XRPL_CONFIG")
        if [ ! -z $override_network ]; then
            NETWORK="$override_network"
            set_environment_configs || return 1
        fi

        local override_rippled_server=$(jq -r ".xrpl.rippledServer | select( . != null )" "$MB_XRPL_CONFIG")
        [ ! -z $override_rippled_server ] && rippled_server="$override_rippled_server"

        xrpl_address=$(jq -r ".xrpl.address | select( . != null )" "$MB_XRPL_CONFIG")
        xrpl_secret_path=$(jq -r ".xrpl.secretPath | select( . != null )" "$MB_XRPL_CONFIG")
        xrpl_secret=$(jq -r ".xrpl.secret | select( . != null )" "$xrpl_secret_path")

        inetaddr=$(jq -r ".hp.host_address | select( . != null )" "$SASHIMONO_CONFIG")
        cpu_micro_sec=$(jq -r ".system.max_cpu_us | select( . != null )" "$SASHIMONO_CONFIG")
        ram_kb=$(jq -r ".system.max_mem_kbytes | select( . != null )" "$SASHIMONO_CONFIG")
        swap_kb=$(jq -r ".system.max_swap_kbytes | select( . != null )" "$SASHIMONO_CONFIG")
        disk_kb=$(jq -r ".system.max_storage_kbytes | select( . != null )" "$SASHIMONO_CONFIG")
        total_instance_count=$(jq -r ".system.max_instance_count | select( . != null )" "$SASHIMONO_CONFIG")
    }

    function download_public_config() {
        echomult "\nDownloading Environment configuration...\n"
        sudo -u $noroot_user curl $public_config_url --output $PUBLIC_CONFIG

        # Network config selection.

        echomult "\nChecking Evernode $NETWORK environment details..."

        if ! jq -e ".${NETWORK}" "$PUBLIC_CONFIG" >/dev/null 2>&1; then
            echomult "Sorry the specified environment has not been configured yet..\n" && exit 1
        fi
    }

    function set_environment_configs() {
        export EVERNODE_GOVERNOR_ADDRESS=${OVERRIDE_EVERNODE_GOVERNOR_ADDRESS:-$(jq -r ".$NETWORK.governorAddress" $PUBLIC_CONFIG)}
        rippled_server=$(jq -r ".$NETWORK.rippledServer" $PUBLIC_CONFIG)
    }

    function generate_and_save_keyfile() {

        account_json=$(exec_jshelper generate-account) || {
            echo "Error occurred in account setting up."
            exit 1
        }
        xrpl_address=$(jq -r '.address' <<<"$account_json")
        xrpl_secret=$(jq -r '.secret' <<<"$account_json")

        if [ "$#" -ne 1 ]; then
            echomult "Error: Please provide the full path of the secret file."
            return 1
        fi

        key_file_path="$1"

        key_dir=$(dirname "$key_file_path")
        if [ ! -d "$key_dir" ]; then
            mkdir -p "$key_dir"
        fi

        if [ "$key_file_path" == "$default_key_filepath" ]; then
            parent_directory=$(dirname "$key_file_path")
            chmod -R 500 "$parent_directory" &&
                chown -R $MB_XRPL_USER: "$parent_directory" || {
                echomult "Error occurred in permission and ownership assignment of key file directory."
                exit 1
            }
        fi

        if [ -e "$key_file_path" ]; then
            if confirm "The file '$key_file_path' already exists. Do you want to continue using that key file?\nPressing 'n' would terminate the installation."; then
                echomult "Continuing with the existing key file."
                existing_secret=$(jq -r '.xrpl.secret' "$key_file_path" 2>/dev/null)
                if [ "$existing_secret" != "null" ] && [ "$existing_secret" != "-" ]; then
                    account_json=$(exec_jshelper generate-account $existing_secret) || {
                        echomult "Error occurred when existing account retrieval."
                        exit 1
                    }
                    xrpl_address=$(jq -r '.address' <<<"$account_json")
                    xrpl_secret=$(jq -r '.secret' <<<"$account_json")

                    chmod 400 "$key_file_path" &&
                        chown $MB_XRPL_USER: $key_file_path || {
                        echomult "Error occurred in permission and ownership assignment of key file."
                        exit 1
                    }
                    echomult "Retrived account details via secret.\n"
                    return 0
                else
                    echomult "Error: Existing secret file does not have the expected format."
                    exit 1
                fi
            else
                exit 1
            fi
        else

            echo "{ \"xrpl\": { \"secret\": \"$xrpl_secret\" } }" >"$key_file_path" &&
                chmod 400 "$key_file_path" &&
                chown $MB_XRPL_USER: $key_file_path &&
                echomult "Key file saved successfully at $key_file_path" || {
                echomult "Error occurred in permission and ownership assignment of key file."
                exit 1
            }

            return 0
        fi

        exit 1
    }

    function exec_mb() {
        local res=$(MB_DATA_DIR="$MB_XRPL_DATA" node "/home/chalith/Workspace/HotpocketDev/sashimono/mb-xrpl/app.js" "$@" | tee >(grep -v "$mb_cli_exit_err" >/dev/fd/2))

        local return_code=0
        [[ "$res" == *"$mb_cli_exit_err"* ]] && return_code=1

        res=$(echo "$res" | sed -n -e "/^$mb_cli_out_prefix: /p")
        echo "${res#"$mb_cli_out_prefix: "}"
        return $return_code
    }

    function burn_leases() {
        if ! res=$(exec_mb burn-leases); then
            multi_choice "An error occurred while burning! What do you want to do" "Retry/Abort/Rollback" && local input=$(multi_choice_output)
            if [ "$input" == "Retry" ]; then
                burn_leases "$@" && return 0
            elif [ "$input" == "Rollback" ]; then
                rollback
            else
                abort
            fi
            return 1
        fi
        return 0
    }

    function mint_leases() {
        if ! res=$(exec_mb mint-leases $total_instance_count); then
            if [[ "$res" == "LEASE_ERR" ]]; then
                if confirm "Do you want to burn minted tokens. (N will abort the installation)" "n"; then
                    burn_leases && mint_leases "$@" && return 0
                else
                    abort
                fi
            else
                multi_choice "An error occurred while minting! What do you want to do" "Retry/Abort/Rollback" && local input=$(multi_choice_output)
                if [ "$input" == "Retry" ]; then
                    mint_leases "$@" && return 0
                elif [ "$input" == "Rollback" ]; then
                    rollback
                else
                    abort
                fi
            fi
            return 1
        fi
        return 0
    }

    function deregister() {
        if ! res=$(exec_mb deregister $1); then
            multi_choice "An error occurred while registering! What do you want to do" "Retry/Abort/Rollback" && local input=$(multi_choice_output)
            if [ "$input" == "Retry" ]; then
                deregister "$@" && return 0
            elif [ "$input" == "Rollback" ]; then
                rollback
            else
                abort
            fi
            return 1
        fi
        return 0
    }

    function register() {
        if ! res=$(exec_mb register $country_code $cpu_micro_sec $ram_kb $swap_kb $disk_kb $total_instance_count $cpu_model $cpu_count $cpu_speed $email_address $description); then
            multi_choice "An error occurred while registering! What do you want to do" "Retry/Abort/Rollback" && local input=$(multi_choice_output)
            if [ "$input" == "Retry" ]; then
                register "$@" && return 0
            elif [ "$input" == "Rollback" ]; then
                rollback
            else
                abort
            fi
            return 1
        fi
        return 0
    }

    function accept_reg_token() {
        if ! res=$(exec_mb accept-reg-token); then
            multi_choice "An error occurred while accepting the reg token! What do you want to do" "Retry/Abort/Rollback" && local input=$(multi_choice_output)
            if [ "$input" == "Retry" ]; then
                accept_reg_token "$@" && return 0
            elif [ "$input" == "Rollback" ]; then
                rollback
            else
                abort
            fi
            return 1
        fi
        return 0
    }

    function check_balance() {
        if ! res=$(exec_mb check-balance); then
            multi_choice "Do you want to re-check the balance" "Retry/Abort/Rollback" && local input=$(multi_choice_output)
            if [ "$input" == "Retry" ]; then
                check_balance "$@" && return 0
            elif [ "$input" == "Rollback" ]; then
                rollback
            else
                abort
            fi
            return 1
        fi

        return 0
    }

    function prepare_host() {
        ([ -z $rippled_server ] || [ -z $xrpl_address ] || [ -z $xrpl_secret_path ] || [ -z $xrpl_secret ] || [ -z $inetaddr ]) && echo "No params specified." && return 1

        local inc_reserves_count=$((1 + 1 + $total_instance_count))
        local min_reserve_requirement=$(exec_jshelper compute-xah-requirement $rippled_server $inc_reserves_count)

        local min_xah_requirement=$(echo "$MIN_OPERATIONAL_COST_PER_MONTH*$MIN_OPERATIONAL_DURATION + $min_reserve_requirement" | bc)

        local min_evr_requirement=$(exec_jshelper compute-evr-requirement $rippled_server $EVERNODE_GOVERNOR_ADDRESS $xrpl_address)

        echomult "Your host account with the address $xrpl_address will be on Xahau $NETWORK.
        \nThe secret key of the account is located at $xrpl_secret_path.
        \nNOTE: It is your responsibility to safeguard/backup this file in a secure manner.
        \nIf you lose it, you will not be able to access any funds in your Host account. NO ONE else can recover it.
        \n\nThis is the account that will represent this host on the Evernode host registry. You need to load up the account with following funds in order to continue with the installation.
        \n1. At least $min_xah_requirement XAH to cover regular transaction fees for the first three months.
        \n2. At least $min_evr_requirement EVR to cover Evernode registration.
        \n\nYou can scan the following QR code in your wallet app to send funds based on the account condition:\n"
        generate_qrcode "$xrpl_address"

        echomult "\nChecking the account condition..."
        echomult "To set up your host account, ensure a deposit of $min_xah_requirement XAH to cover the regular transaction fees for the first three months."

        required_balance=$min_xah_requirement
        while true; do
            wait_call "exec_jshelper check-balance $rippled_server $EVERNODE_GOVERNOR_ADDRESS $xrpl_address NATIVE $required_balance" "Thank you. [OUTPUT] XAH balance is there in your host account." &&
                break
            confirm "\nDo you want to re-check the balance?\nPressing 'n' would terminate the installation." || exit 1
        done

        echomult "\nPreparing host account..."
        while true; do
            wait_call "exec_jshelper prepare-host $rippled_server $EVERNODE_GOVERNOR_ADDRESS $xrpl_address $xrpl_secret $inetaddr" "Account preparation is successfull." && break
            confirm "\nDo you want to re-try account preparation?\nPressing 'n' would terminate the installation." || exit 1
        done

        echomult "\n\nIn order to register in Evernode you need to have $min_evr_requirement EVR balance in your host account. Please deposit the required registration fee in EVRs.
        \nYou can scan the provided QR code in your wallet app to send funds:"

        required_balance=$min_evr_requirement
        while true; do
            wait_call "exec_jshelper check-balance $rippled_server $EVERNODE_GOVERNOR_ADDRESS $xrpl_address ISSUED $required_balance" "Thank you. [OUTPUT] EVR balance is there in your host account." &&
                break
            confirm "\nDo you want to re-check the balance?\nPressing 'n' would terminate the installation." || exit 1
        done
    }

    function check_and_register() {
        if ! res=$(exec_mb check-reg); then
            if [[ "$res" == "ACC_NOT_FOUND" ]]; then
                echo "Account not found, Please check your account and try again." && abort
                return 1
            elif [[ "$res" == "INVALID_REG" ]]; then
                echo "Invalid registration please transfer and try again" && abort
                return 1
            elif [[ "$res" == "PENDING_SELL_OFFER" ]]; then
                register && return 0
                return 1
            elif [[ "$res" == "PENDING_TRANSFER" ]] || [[ "$res" == "NOT_REGISTERED" ]]; then
                check_balance && register && return 0
                return 1
            fi
        elif [[ "$res" == "REGISTERED" ]]; then
            echo "This host is registered"
            return 0
        fi

        echo "Invalid registration please transfer and try again" && abort
        return 1
    }

    function check_and_deregister() {
        if ! res=$(exec_mb check-reg); then
            if [[ "$res" == "NOT_REGISTERED" ]]; then
                echo "This host is de-registered"
                return 0
            elif [[ "$res" == "ACC_NOT_FOUND" ]]; then
                echo "Account not found, Please check your account and try again." && abort
                return 1
            elif [[ "$res" == "INVALID_REG" ]]; then
                echo "Invalid registration please transfer and try again" && abort
                return 1
            elif [[ "$res" == "PENDING_SELL_OFFER" ]]; then
                accept_reg_token && deregister && return 0
                return 1
            elif [[ "$res" == "PENDING_TRANSFER" ]]; then
                echo "There a pending transfer, Please re-install and try again." && abort
                return 1
            fi
        elif [[ "$res" == "REGISTERED" ]]; then
            deregister
            return 0
        fi

        echo "Invalid registration please transfer and try again" && abort
        return 1
    }

    function xah_balance_check_and_wait {
        ([ -z $rippled_server ] || [ -z $xrpl_address ] || [ -z $xrpl_secret ] || [ -z $inetaddr ]) && echo "No params specified." && return 1

        # min_xah_requirement => reserve_base_xrp + reserve_inc_xrp * n
        # reserve_inc_xrp * n => trustline reserve + reg_token_reserve + (reserve_inc_xrp * instance_count)
        local inc_reserves_count=$((1 + 1 + $total_instance_count))
        local min_reserve_requirement=$(exec_jshelper compute-xah-requirement $rippled_server $inc_reserves_count)

        local min_xah_requirement=$(echo "$MIN_OPERATIONAL_COST_PER_MONTH*$MIN_OPERATIONAL_DURATON + $min_reserve_requirement" | bc)

        echomult "Your host account with the address $xrpl_address will be on Xahau $NETWORK.
        \nThe secret key of the account is located at $key_file_path.
        \nNOTE: It is your responsibility to safeguard/backup this file in a secure manner.
        \nIf you lose it, you will not be able to access any funds in your Host account. NO ONE else can recover it.
        \n\nThis is the account that will represent this host on the Evernode host registry. You need to load up the account with following funds in order to continue with the installation.
        \n1. At least $min_xah_requirement XAH to cover regular transaction fees for the first three months.
        \n2. At least $reg_fee EVR to cover Evernode registration fee.
        \n\nYou can scan the following QR code in your wallet app to send funds based on the account condition:\n"
        generate_qrcode "$xrpl_address"

        echomult "\nChecking the account condition..."
        echomult "To set up your host account, ensure a deposit of $min_xah_requirement XAH to cover the regular transaction fees for the first three months."

        wait_call "wait_for_funds NATIVE $min_xah_requirement" || return 1
    }

    function evr_balance_check_and_wait {
        ([ -z $rippled_server ] || [ -z $xrpl_address ] || [ -z $xrpl_secret ] || [ -z $inetaddr ]) && echo "No params specified." && return 1

        local min_evr_requirement=$(exec_jshelper compute-evr-requirement $rippled_server $EVERNODE_GOVERNOR_ADDRESS $xrpl_address)

        [ $min_evr_requirement -eq 0 ] && return 0

        echomult "\n\nIn order to register in Evernode you need to have $min_evr_requirement EVR balance in your host account. Please deposit the required registration fee in EVRs.
        \nYou can scan the provided QR code in your wallet app to send funds:"

        wait_call "wait_for_funds ISSUED $min_evr_requirement" || return 1
    }

    download_public_config && set_environment_configs || rollback

    # If file not exist.
    if [ ! -f $MB_XRPL_CONFIG ]; then
        # Ask consent to generate new account or use and existing.
        generate_and_save_keyfile || abort
    fi

    # Override rippled server.
    read_configs || abort

    prepare_host || abort

    check_and_register || abort

    mint_leases || abort

    exit 0

    # surrounding braces  are needed make the whole script to be buffered on client before execution.
}
