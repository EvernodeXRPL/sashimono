#!/bin/bash
echo "Sashimono bootstrap contract upgrader."
echo "Execution lcl $1-$2"

archive_name="bundle.zip"
bootstrap_bin="bootstrap_contract"
install_script="install.sh"
patch_cfg="../patch.cfg"
patch_cfg_bk="../patch.cfg.bk"
contract_config="contract.config"
self_original_name="bootstrap_upgrade.sh" # Original name of this script before it was renamed to post_exec.sh
self_path=$(realpath $0) # Full path of this script.
self_name=$(basename $self_path) # File name of this script.
self_dir=$(dirname $self_path) # Parent path of this script.

function upgrade() {

    # Check for binary archive availability.
    if [ ! -f "$archive_name" ]; then
        echo "Required $archive_name not found. Exiting.."
        return 1
    fi

    # Unzipping the archive.

    # unzip command is used for zip extraction.
    if ! command -v unzip &>/dev/null; then
        echo "unzip utility not found. Exiting.."
        return 1
    fi

    unzip -o $archive_name >>/dev/null

    if [ -f "$contract_config" ]; then
        # jq command is used for json manipulation.
        if ! command -v jq &>/dev/null; then
            echo "jq utility not found. Exiting.."
            return 1
        fi

        # ********Config check********
        version=$(jq '.version' $contract_config)
        if [ "$version" == "null" ] || [ ${#version} -eq 2 ]; then # Empty means ""
            echo "Version cannot be empty"
            return 1
        fi

        unl=$(jq '.unl' $contract_config)
        unl_res=$(jq '.unl? | map(length == 66 and startswith("ed")) | index(false)' $contract_config)
        if [ "$unl_res" != "null" ]; then
            echo "Unl pubkey invalid. Invalid format. Key should be 66 in length with ed prefix"
            return 1
        fi

        bin_path=$(jq '.bin_path' $contract_config)
        if [ "$bin_path" == "null" ] || [ ${#bin_path} -eq 2 ]; then # Empty means ""
            echo "bin_path cannot be empty"
            return 1
        fi

        if [ ! -f "${bin_path:1:-1}" ]; then
            echo "Given binary file: $bin_path not found"
            return 1
        fi

        bin_args=$(jq '.bin_args' $contract_config)
        environment=$(jq '.environment' $contract_config)

        roundtime=$(jq '.roundtime' $contract_config)
        if [ "$roundtime" -le 0 ] || [ "$roundtime" -gt 3600000 ]; then
            echo "Round time must be between 1 and 3600000ms inclusive."
            return 1
        fi

        stage_slice=$(jq '.stage_slice' $contract_config)
        if [ "$stage_slice" -le 0 ] || [ "$stage_slice" -gt 33 ]; then
            echo "Stage slice must be between 1 and 33 percent inclusive."
            return 1
        fi

        consensus=$(jq '.consensus' $contract_config)
        if [ "$consensus" == "null" ] || [ ${#consensus} -eq 2 ] || { [ "$consensus" != "\"public\"" ] && [ "$consensus" != "\"private\"" ]; }; then
            echo "Invalid consensus flag. Valid values: public|private."
            return 1
        fi

        npl=$(jq '.npl' $contract_config)
        if [ "$npl" == "null" ] || [ ${#npl} -eq 2 ] || { [ "$npl" != "\"public\"" ] && [ "$npl" != "\"private\"" ]; }; then
            echo "Invalid npl flag. Valid values: public|private."
            return 1
        fi

        max_input_ledger_offset=$(jq '.max_input_ledger_offset' $contract_config)
        if [ "$max_input_ledger_offset" -lt 0 ]; then
            echo "Invalid max input ledger offset. Should be greater than zero."
            return 1
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
            return 1
        fi
        echo "All $contract_config checks passed."

        echo "Updating $patch_cfg file."
        new_patch=$(jq -M ". + {\
        version:$version,\
        bin_path:$bin_path,\
        bin_args:$bin_args,\
        environment:$environment,\
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
        }" $patch_cfg)
        cp $patch_cfg $patch_cfg_bk # Make a backup.
        echo "$new_patch" >$patch_cfg

        # Remove contract.config after patch file update.
        rm $contract_config
    fi

    # *****Install Script*****.
    if [ -f "$install_script" ]; then
        echo "$install_script found. Executing..."

        chmod +x $install_script
        ./$install_script
        installcode=$?
        
        rm $install_script

        if [ "$installcode" -eq "0" ]; then
            echo "$install_script executed successfully."
            return 0
        else
            echo "$install_script ended with exit code:$installcode"
            return 1
        fi
    fi

    return 0
}

function rollback() {
    # Restore self-script original name (Because hp requires it to be named post_exec.sh before execution)
    cp $self_name $self_original_name
    # Restore patch.cfg
    mv $patch_cfg_bk $patch_cfg
    # Remove all files except the ones we need.
    find . -not \( -name $bootstrap_bin -or -name $self_original_name -or -name $self_name \) -delete
    return 0
}

# Perform upgrade and rollback if failed.
upgrade
upgradecode=$?

pushd $self_dir > /dev/null 2>&1
if [ "$upgradecode" -eq "0" ]; then
    # We have upgraded the contract successfully. Cleanup bootstrap contract resources.
    echo "Upgrade successful. Cleaning up."
    rm $archive_name $bootstrap_bin $patch_cfg_bk
else
    echo "Upgrade failed. Rolling back."
    rollback
fi
finalcode=$?
popd > /dev/null 2>&1

exit $finalcode
