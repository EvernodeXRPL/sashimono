#!/bin/bash
# Sashimono hpfs systemd service registration script.
# This is called by sashimono to start two services for contract fs and ledger fs.
username=$1
contract_dir=$2
log_level=$3
merge=$4

sashimono_bin=/usr/bin/sashimono-agent
contract_fs_service="$username"-contract_fs
ledger_fs_service="$username"-ledger_fs
#     After=sashimono-agent.service
echo "[Unit]
    Description=Running and monitoring $username contract fs.
    StartLimitIntervalSec=0
    [Service]
    User=$username
    Group=$username
    Type=simple
    ExecStart=$sashimono_bin/hpfs fs $contract_dir/contract_fs $contract_dir/contract_fs/mnt merge=$merge ugid= trace=$log_level
    Restart=on-failure
    RestartSec=5
    [Install]
    WantedBy=multi-user.target" >/etc/systemd/system/"$contract_fs_service".service

echo "[Unit]
    Description=Running and monitoring $username ledger fs.
    StartLimitIntervalSec=0
    [Service]
    User=$username
    Group=$username
    Type=simple
    ExecStart=$sashimono_bin/hpfs fs $contract_dir/ledger_fs $contract_dir/ledger_fs/mnt merge=true ugid= trace=$log_level
    Restart=on-failure
    RestartSec=5
    [Install]
    WantedBy=multi-user.target" >/etc/systemd/system/"$ledger_fs_service".service

systemctl daemon-reload
systemctl enable "$contract_fs_service"
systemctl enable "$ledger_fs_service"
systemctl start "$contract_fs_service"
systemctl start "$ledger_fs_service"

echo "$contract_fs_service, $ledger_fs_service, INST_SUC"
exit 0
