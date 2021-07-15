#!/bin/bash
# Sashimono contract instance user installation script.
# This is intended to be called by Sashimono agent.

# Check for user cpu and memory quotas.
cpu=$1
memory=$2
disk=$3
contract_dir=$4
contract_uid=$5
contract_gid=$6
if [ -z "$cpu" ] || [ -z "$memory" ] || [ -z "$disk" ] || [ -z "$contract_dir" ] || [ -z "$contract_uid" ] || [ -z "$contract_gid" ]; then
    echo "Expected: user-install.sh <cpu quota microseconds> <memory quota kbytes> <disk quota kbytes> <contract dir> <contract uid> <contract gid>"
    echo "INVALID_PARAMS,INST_ERR" && exit 1
fi

prefix="sashi"
suffix=$(date +%s%N) # Epoch nanoseconds
user="$prefix$suffix"
group="sashimonousers"
cgroupsuffix="-cg"
user_dir=/home/$user
script_dir=$(dirname "$(realpath "$0")")
docker_bin=$script_dir/dockerbin

# Check if users already exists.
[ "$(id -u "$user" 2>/dev/null || echo -1)" -ge 0 ] && echo "HAS_USER,INST_ERR" && exit 1

# Check cgroup mounts exists.
{ [ ! -d /sys/fs/cgroup/cpu ] || [ ! -d /sys/fs/cgroup/memory ]; } && echo "CGROUP_ERR,INST_ERR" && exit 1

function rollback() {
    echo "Rolling back user installation. $1"
    "$script_dir"/user-uninstall.sh "$user"
    echo "Rolled back the installation."
    echo "$1,INST_ERR" && exit 1
}

# Setup user and dockerd service.
useradd --shell /usr/sbin/nologin -m "$user"
usermod --lock "$user"
usermod -a -G $group "$user"
loginctl enable-linger "$user" # Enable lingering to support rootless dockerd service installation.
chmod o-rwx "$user_dir"
echo "Created '$user' user."

user_id=$(id -u "$user")
user_runtime_dir="/run/user/$user_id"
dockerd_socket="unix://$user_runtime_dir/docker.sock"

# Setup user cgroup.
! (cgcreate -g cpu:$user$cgroupsuffix &&
    echo "$cpu" >/sys/fs/cgroup/cpu/$user$cgroupsuffix/cpu.cfs_quota_us) && rollback "CGROUP_CPU_CREAT"
! (cgcreate -g memory:$user$cgroupsuffix &&
    echo "${memory}K" >/sys/fs/cgroup/memory/$user$cgroupsuffix/memory.limit_in_bytes &&
    echo "${memory}K" >/sys/fs/cgroup/memory/$user$cgroupsuffix/memory.memsw.limit_in_bytes) && rollback "CGROUP_MEM_CREAT"

# Adding disk quota to the new user.
setquota -u -F vfsv0 "$user" "$disk" "$disk" 0 0 /

echo "Configured the resources"

# Setup env variables for the user.
echo "
export XDG_RUNTIME_DIR=$user_runtime_dir
export PATH=$docker_bin:\$PATH
export DOCKER_HOST=$dockerd_socket" >>"$user_dir"/.bashrc
echo "Updated user .bashrc."

# Wait until user systemd is functioning.
user_systemd=""
for ((i = 0; i < 30; i++)); do
    sleep 0.1
    user_systemd=$(sudo -u "$user" XDG_RUNTIME_DIR="$user_runtime_dir" systemctl --user is-system-running 2>/dev/null)
    [ "$user_systemd" == "running" ] && break
done
[ "$user_systemd" != "running" ] && rollback "NO_SYSTEMD"

echo "Installing rootless dockerd for user."
sudo -H -u "$user" PATH="$docker_bin":"$PATH" XDG_RUNTIME_DIR="$user_runtime_dir" "$docker_bin"/dockerd-rootless-setuptool.sh install

svcstat=$(sudo -u "$user" XDG_RUNTIME_DIR="$user_runtime_dir" systemctl --user is-active docker.service)
[ "$svcstat" != "active" ] && rollback "NO_DOCKERSVC"

echo "Installed rootless dockerd."

echo "Adding hpfs services for the instance."

# Taking the uid and gid offsets
uoffset=$(grep "^$user:[0-9]\+:[0-9]\+$" /etc/subuid | cut -d: -f2)
[ -z $uoffset ] && rollback "SUBUID_ERR"
goffset=$(grep "^$user:[0-9]\+:[0-9]\+$" /etc/subgid | cut -d: -f2)
[ -z $goffset ] && rollback "SUBGID_ERR"
hpfs_uid=$(expr $uoffset + $contract_uid)
hpfs_gid=$(expr $goffset + $contract_gid)

# Only contract fs will be run as contract guid.
echo "[Unit]
Description=Running and monitoring contract fs.
StartLimitIntervalSec=0
[Service]
Type=simple
EnvironmentFile=-$user_dir/.serviceconf
ExecStart=$script_dir/hpfs fs $user_dir/$contract_dir/contract_fs $user_dir/$contract_dir/contract_fs/mnt merge=\${HPFS_MERGE} ugid= trace=\${HPFS_TRACE}
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target" >"$user_dir"/.config/systemd/user/contract_fs.service

echo "[Unit]
Description=Running and monitoring ledger fs.
StartLimitIntervalSec=0
[Service]
Type=simple
EnvironmentFile=-$user_dir/.serviceconf
ExecStart=$script_dir/hpfs fs $user_dir/$contract_dir/ledger_fs $user_dir/$contract_dir/ledger_fs/mnt merge=true ugid= trace=\${HPFS_TRACE}
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target" >"$user_dir"/.config/systemd/user/ledger_fs.service

sudo -u "$user" XDG_RUNTIME_DIR="$user_runtime_dir" systemctl --user daemon-reload
echo "$user_id,$user,$dockerd_socket,INST_SUC"
exit 0
