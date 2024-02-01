#!/bin/bash
# Evernode host setup tool to manage Sashimono installation and host registration.
# This script is also used as the 'evernode' cli alias after the installation.
# usage: ./setup.sh install

# surrounding braces  are needed make the whole script to be buffered on client before execution.
{
    instance_count=10
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
                burn_leases
            elif [ "$input" == "rollback" ]; then
                rollback
            else
                abort
            fi
        fi
    }

    function mint_leases() {
        local res=$(exec_mb mint-leases $instance_count)
        if [[ "$res" == *"$mb_error"* ]]; then
            res=$(echo "$res" | tail -n 2 | head -n 1)
            if [[ "$res" == "LEASE_ERR"* ]]; then
                if confirm "Do you want to burn minted tokens. (N will abort the installation)" "n"; then
                    burn_leases && mint_leases
                else
                    abort
                fi
            else
                choice "An error occured while minting! What do you want to do" "retry/abort/rollback" && local input=$(choice_output)
                if [ "$input" == "retry" ]; then
                    mint_leases
                elif [ "$input" == "rollback" ]; then
                    rollback
                else
                    abort
                fi
            fi
        fi
    }

    mint_leases

    exit 0

    # surrounding braces  are needed make the whole script to be buffered on client before execution.
}
