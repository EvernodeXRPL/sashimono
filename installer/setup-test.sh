#!/bin/bash
# Evernode host setup tool to manage Sashimono installation and host registration.
# This script is also used as the 'evernode' cli alias after the installation.
# usage: ./setup.sh install

# surrounding braces  are needed make the whole script to be buffered on client before execution.
{
    country_code="AU"
    cpu_micro_sec=1
    ram_kb=1000000
    swap_kb=1000000
    disk_kb=1000000
    total_instance_count=10
    cpu_model="test"
    cpu_count=4
    cpu_speed=5
    email_address="test@gmail.com"
    description="test"

    mb_error="Evernode Xahau message board exiting with error."
    choice_result=""

    function confirm() {
        local prompt=$1
        local defaultChoice=${2:-y} #Default choice is set to 'y' if $2 parameter is not provided.

        local choiceDisplay="[Y/n]"
        if [ "$defaultChoice" == "n" ]; then
            choiceDisplay="[y/N]"
        fi

        echo -en "$prompt $choiceDisplay "
        local yn=""
        read yn </dev/tty

        # Default choice is 'y'
        [ -z $yn ] && yn="$defaultChoice"
        while ! [[ $yn =~ ^[Yy|Nn]$ ]]; do
            read -ep "'y' or 'n' expected: " yn </dev/tty
        done

        echo ""                                     # Insert new line after answering.
        [[ $yn =~ ^[Yy]$ ]] && return 0 || return 1 # 0 means success.
    }

    function choice() {
        local prompt=$1

        local choiceDisplay=${2:-y/n}

        echo -en "$prompt [$choiceDisplay]? "
        read choice_result </dev/tty

        IFS='/'
        read -ra ADDR <<<"$choiceDisplay"

        while ! [[ "${ADDR[@]}" =~ $choice_result ]]; do
            read -ep "[$choiceDisplay] expected: " choice_result </dev/tty
        done
    }

    function choice_output() {
        echo $choice_result
    }

    function rollback() {
        echo "Rollbacking the instalation.."
        burn_leases
        deregister
        exit 0
    }

    function abort() {
        echo "Aborting the instalation.."
        exit 0
    }

    function exec_mb() {
        local res=$(MB_DATA_DIR="/home/chalith/Workspace/HotpocketDev/sashimono/mb-xrpl" node "/home/chalith/Workspace/HotpocketDev/sashimono/mb-xrpl/app.js" "$@" | tee /dev/fd/2)
        echo $res
    }

    function burn_leases() {
        local res=$(exec_mb burn-leases)
        if [[ "$res" == *"$mb_error"* ]]; then
            choice "An error occured while burning! What do you want to do" "retry/abort/rollback" && local input=$(choice_output)
            if [ "$input" == "retry" ]; then
                burn_leases && return 0
            elif [ "$input" == "rollback" ]; then
                rollback
            else
                abort
            fi
            return 1
        fi
        return 0
    }

    function mint_leases() {
        local res=$(exec_mb mint-leases $total_instance_count)
        if [[ "$res" == *"$mb_error"* ]]; then
            res=$(echo "$res" | tail -n 2 | head -n 1)
            if [[ "$res" == "LEASE_ERR"* ]]; then
                if confirm "Do you want to burn minted tokens. (N will abort the installation)" "n"; then
                    burn_leases && mint_leases && return 0
                else
                    abort
                fi
            else
                choice "An error occured while minting! What do you want to do" "retry/abort/rollback" && local input=$(choice_output)
                if [ "$input" == "retry" ]; then
                    mint_leases && return 0
                elif [ "$input" == "rollback" ]; then
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
        local res=$(exec_mb deregister $1)
        if [[ "$res" == *"$mb_error"* ]]; then
            res=$(echo "$res" | tail -n 2 | head -n 1)
            choice "An error occured while registering! What do you want to do" "retry/abort/rollback" && local input=$(choice_output)
            if [ "$input" == "retry" ]; then
                deregister $1 && return 0
            elif [ "$input" == "rollback" ]; then
                rollback
            else
                abort
            fi
            return 1
        fi
        return 0
    }

    function register() {
        local res=$(exec_mb register $country_code $cpu_micro_sec $ram_kb $swap_kb $disk_kb $total_instance_count $cpu_model $cpu_count $cpu_speed $email_address $description)
        if [[ "$res" == *"$mb_error"* ]]; then
            res=$(echo "$res" | tail -n 2 | head -n 1)
            choice "An error occured while registering! What do you want to do" "retry/abort/rollback" && local input=$(choice_output)
            if [ "$input" == "retry" ]; then
                register && return 0
            elif [ "$input" == "rollback" ]; then
                rollback
            else
                abort
            fi
            return 1
        fi
        return 0
    }

    function check_balance() {
        local res=$(exec_mb check-balance)
        if [[ "$res" == *"$mb_error"* ]]; then
            res=$(echo "$res" | tail -n 2 | head -n 1)
            if [[ "$res" == "ERROR"* ]]; then
                choice "Balance check failed! What do you want to do" "retry/abort/rollback" && local input=$(choice_output)
                if [ "$input" == "retry" ]; then
                    check_balance && return 0
                elif [ "$input" == "rollback" ]; then
                    rollback
                else
                    abort
                fi
            fi
            return 1
        fi

        return 0
    }

    function check_and_register() {
        local res=$(exec_mb check-reg)
        if [[ "$res" == *"$mb_error"* ]]; then
            res=$(echo "$res" | tail -n 2 | head -n 1)
            if [[ "$res" == "ACC_NOT_FOUND"* ]]; then
                echo "Account not found, Please check your account and try again." && abort
            elif [[ "$res" == "INVALID_REG"* ]]; then
                echo "Invalid registration please transfer and try again" && abort
            elif [[ "$res" == "PENDING_SELL_OFFER"* ]]; then
                register && return 0
            elif [[ "$res" == "PENDING_TRANSFER"* ]] || [[ "$res" == "NOT_REGISTERED"* ]]; then
                check_balance && register && return 0
            fi
            return 1
        fi

        res=$(echo "$res" | tail -n 2 | head -n 1)
        if [[ "$res" == "REGISTERED" ]]; then
            echo "This host is registered"
            return 0
        else
            echo "Invalid registration please transfer and try again" && abort
        fi
        return 1
    }

    check_and_register || abort

    mint_leases || abort

    exit 0

    # surrounding braces  are needed make the whole script to be buffered on client before execution.
}
