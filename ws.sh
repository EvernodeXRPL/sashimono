#!/bin/bash
./installer/websocat wss://hooks-testnet-v2.xrpl-labs.com <<< '{"command": "account_lines","account": "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn"}'
# echo 'aaaa{"result":{"account":"ryP9kGFLWXsEXyznp5YS91HFu8KJyQLGL","ledger_current_index":8819560,"lines":[{"account":"rfxLPXCcSmwR99dV97yFozBzrzpvCa2VCf","balance":"165390.7659902687","currency":"EVR","limit":"9999999999999900e-2","limit_peer":"0","no_ripple":true,"no_ripple_peer":false,"quality_in":0,"quality_out":0},{"account":"ravin2","balance":"333333","currency":"EVR","limit":"9999999999999900e-2","limit_peer":"0","no_ripple":true,"no_ripple_peer":false,"quality_in":0,"quality_out":0}],"validated":false},"status":"success","type":"response"}'

