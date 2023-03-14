#!/bin/bash
# Governance management tool.
# usage: ./governance.sh

# Helper to print multi line text.
# (When passed as a parameter, bash auto strips spaces and indentation which is what we want)
function echomult() {
    echo -e $1
}

[ "$1" != "propose" ] && [ "$1" != "withdraw" ] &&
    echomult "$evernode host management tool
            \nSupported commands:
            \npropose [hash-file-path] [short-name] - Propose new governance candidate
            \nwithdraw [candidate-id] - Withdraw proposed governance candidate" &&
    exit 1
mode=$1

if [ "$mode" == "propose" ] || [ "$mode" == "withdraw" ]; then
    [ "$EUID" -ne 0 ] && echo "Please run with root privileges (sudo)." && exit 1
fi

if [ "$mode" == "propose" ]; then
    hash_file_path=$2
    short_name=$3

    ([ -z "$hash_file_path" ] || [ ! -f "$hash_file_path" ]) && echo -e "Invalid hash file path $hash_file_path" && exit 1
    [ -z "$short_name" ] && echo -e "Invalid short name $short_name" && exit 1

    if ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN governance-propose $hash_file_path $short_name; then
        echo "Governance candidate propose failed." && exit 1
    fi

    echo "Successfully proposed governance candidate."

elif [ "$mode" == "withdraw" ]; then
    candidate_id=$2

    [ -z "$candidate_id" ] && echo -e "Invalid candidate id $candidate_id" && exit 1

    if ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN governance-withdraw $candidate_id; then
        echo "Governance candidate withdraw failed." && exit 1
    fi

    echo "Successfully withdrawn governance candidate."

elif [ "$mode" == "vote" ]; then
    candidate_id=$2

    [ -z "$candidate_id" ] && echo -e "Invalid candidate id $candidate_id" && exit 1

    if ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN governance-vote $candidate_id; then
        echo "Governance candidate vote failed." && exit 1
    fi

    echo "Successfully voted for the governance candidate."

elif [ "$mode" == "unvote" ]; then
    candidate_id=$2

    [ -z "$candidate_id" ] && echo -e "Invalid candidate id $candidate_id" && exit 1

    if ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN governance-unvote $candidate_id; then
        echo "Governance candidate unvote failed." && exit 1
    fi

    echo "Successfully unvoted the governance candidate vote."

fi

exit 0
