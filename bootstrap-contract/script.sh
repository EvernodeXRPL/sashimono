#!/bin/bash
echo "Invoked seqence number: $1"
echo "Invoked lcl: $2"
archive_name="bundle.zip"
boostrap_bin="bootstrap_contract"
install_script="install.sh"
contract_config="contract.config"

# Check for binary archive availability.
if [ ! -f "$archive_name" ]; then
    echo "Required $archive_name not found. Exiting.."
    exit 1
fi

# Unzipping the archive.

# unzip command is used for zip extraction.
if ! command -v unzip &>/dev/null; then
    echo "unzip utility not found. Installing.."
    apt-get install -y unzip >/dev/null 2>&1
fi

unzip -o $archive_name >>/dev/null

# Verify necessary files in the archive.
if [ ! -f "$install_script" ] || [ ! -f "$contract_config" ]; then
    echo "Required $install_script or $contract_config not found. Exiting.."
    exit 1
fi

# jq command is used for json manipulation.
if ! command -v jq &>/dev/null; then
    echo "jq utility not found. Installing.."
    apt-get install -y jq >/dev/null 2>&1
fi

# ********Config check********
version=$(jq '.version' $contract_config)
if [ "$version" == "null" ] || [ ${#version} -eq 2 ]; then # Empty means ""
    echo "Version cannot be empty"
    exit 1
fi

unl=$(jq '.unl' $contract_config)
unl_res=$(jq '.unl? | map(length == 66 and startswith("ed")) | index(false)' $contract_config)
if [ "$unl_res" != "null" ]; then
    echo "Unl pubkey invalid. Invalid format. Key should be 66 in length with ed prefix"
    exit 1
fi

bin_path=$(jq '.bin_path' $contract_config)
if [ "$bin_path" == "null" ] || [ ${#bin_path} -eq 2 ]; then # Empty means ""
    echo "bin_path cannot be empty"
    exit 1
fi

if [ ! -f "${bin_path:1:-1}" ]; then
    echo "Given binary file: $bin_path not found"
    exit 1
fi

bin_args=$(jq '.bin_args' $contract_config)

roundtime=$(jq '.roundtime' $contract_config)
if [ "$roundtime" -le 0 ] || [ "$roundtime" -gt 3600000 ]; then
    echo "Round time must be between 1 and 3600000ms inclusive."
    exit 1
fi

stage_slice=$(jq '.stage_slice' $contract_config)
if [ "$stage_slice" -le 0 ] || [ "$stage_slice" -gt 33 ]; then
    echo "Stage slice must be between 1 and 33 percent inclusive."
    exit 1
fi

consensus=$(jq '.consensus' $contract_config)
if [ "$consensus" == "null" ] || [ ${#consensus} -eq 2 ] || { [ "$consensus" != "\"public\"" ] && [ "$consensus" != "\"private\"" ]; }; then
    echo "Invalid consensus flag. Valid values: public|private."
    exit 1
fi

npl=$(jq '.npl' $contract_config)
if [ "$npl" == "null" ] || [ ${#npl} -eq 2 ] || { [ "$npl" != "\"public\"" ] && [ "$npl" != "\"private\"" ]; }; then
    echo "Invalid npl flag. Valid values: public|private."
    exit 1
fi

max_input_ledger_offset=$(jq '.max_input_ledger_offset' $contract_config)
if [ "$max_input_ledger_offset" -lt 0 ]; then
    echo "Invalid max input ledger offset. Should be greater than zero."
    exit 1
fi

appbill_mode=$(jq '.appbill.mode' $contract_config)
appbill_bin_args=$(jq '.appbill.bin_args' $contract_config)
r_user_input_bytes=$(jq '.round_limits.user_input_bytes' $contract_config)
r_user_output_bytes=$(jq '.round_limits.user_output_bytes' $contract_config)
r_npl_output_bytes=$(jq '.round_limits.npl_output_bytes' $contract_config)
r_proc_cpu_seconds=$(jq '.round_limits.proc_cpu_seconds' $contract_config)
r_proc_mem_bytes=$(jq '.round_limits.proc_mem_bytes' $contract_config)
r_proc_ofd_count=$(jq '.round_limits.proc_ofd_count' $contract_config)
if [ "$r_user_input_bytes" -lt 0 ] || [ "$r_user_output_bytes" -lt 0 ] || [ "$r_npl_output_bytes" -lt 0 ] ||
    [ "$r_proc_cpu_seconds" -lt 0 ] || [ "$r_proc_mem_bytes" -lt 0 ] || [ "$r_proc_ofd_count" -lt 0 ]; then
    echo "Invalid round limits."
    exit 1
fi
echo "All $contract_config checks passed."

# *****Install Script*****.
# Executing permissions.
chmod +x $install_script
# Executing install script
./$install_script

echo "patch config"
patch="../patch.cfg"
# add the unl to below modification. removed for easy testing
new_patch=$(jq -M ". + {\
    version:$version,\
    bin_path:$bin_path,\
    bin_args:$bin_args,\
    unl: $unl,\
    roundtime:$roundtime,\
    stage_slice:$stage_slice,\
    consensus: $consensus,\
    npl: $npl,\
    max_input_ledger_offset: $max_input_ledger_offset,\
    appbill: {mode: $appbill_mode, bin_args: $appbill_bin_args},\
    round_limits: {user_input_bytes: $r_user_input_bytes,\
                   user_output_bytes: $r_user_output_bytes,\
                   npl_output_bytes: $r_npl_output_bytes,\
                   proc_cpu_seconds: $r_proc_cpu_seconds,\
                   proc_mem_bytes: $r_proc_mem_bytes,\
                   proc_ofd_count: $r_proc_ofd_count}
    }" $patch)
echo "$new_patch" >>tmp.cfg && mv tmp.cfg $patch

# Do the cleanups
rm $archive_name $install_script $contract_config $boostrap_bin
exit 0
