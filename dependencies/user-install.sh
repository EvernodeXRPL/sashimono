#!/bin/bash
# Sashimono contract instance user installation script.
# This is intended to be called by Sashimono agent.

# Check for user cpu and memory quotas.
cpu=$1
memory=$2
swapmem=$3
disk=$4
contract_dir=$5
contract_uid=$6
contract_gid=$7
if [ -z "$cpu" ] || [ -z "$memory" ] || [ -z "$swapmem" ] || [ -z "$disk" ] || [ -z "$contract_dir" ] || [ -z "$contract_uid" ] || [ -z "$contract_gid" ]; then
    echo "Expected: user-install.sh <cpu quota microseconds> <memory quota kbytes> <swap quota kbytes> <disk quota kbytes> <contract dir> <contract uid> <contract gid>"
    echo "INVALID_PARAMS,INST_ERR" && exit 1
fi

prefix="sashi"
suffix=$(date +%s%N) # Epoch nanoseconds
user="$prefix$suffix"
contract_user="$user-secuser"
group="sashiuser"
cgroupsuffix="-cg"
user_dir=/home/$user
script_dir=$(dirname "$(realpath "$0")")
docker_bin=$script_dir/dockerbin
docker_service="docker.service"

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

# Waits until a service becomes ready up to 3 seconds.
function service_ready() {
    local svcstat=""
    for ((i = 0; i < 30; i++)); do
        sleep 0.1
        svcstat=$(sudo -u "$user" XDG_RUNTIME_DIR="$user_runtime_dir" systemctl --user is-active $1)
        if [ "$svcstat" == "active" ]; then
            return 0 # Success
        fi
    done
    return 1 # Error
}

# Setup user and dockerd service.
useradd --shell /usr/sbin/nologin -m $user
usermod --lock $user
usermod -a -G $group $user
loginctl enable-linger $user # Enable lingering to support rootless dockerd service installation.
chmod o-rwx "$user_dir"
echo "Created '$user' user."

# Creating a secondary user for the contract.
# This is the respective host user for the child user of the sashimono user inside docker container.
# Taking the uid and gid offsets.
uoffset=$(grep "^$user:[0-9]\+:[0-9]\+$" /etc/subuid | cut -d: -f2)
[ -z $uoffset ] && rollback "SUBUID_ERR"
contract_host_uid=$(expr $uoffset + $contract_uid - 1)

# If contract gid is not 0, get the calculated host gid and create the contract user group
# and create user inside both contract user group and sashimono user group.
# Otherwise get sashimono user's gid and create contract user inside that group.
if [ ! $contract_gid -eq 0 ]; then
    goffset=$(grep "^$user:[0-9]\+:[0-9]\+$" /etc/subgid | cut -d: -f2)
    [ -z $goffset ] && rollback "SUBGID_ERR"
    contract_host_gid=$(expr $goffset + $contract_gid - 1)
    groupadd -g "$contract_host_gid" "$contract_user"
    useradd --shell /usr/sbin/nologin -M -g "$contract_host_gid" -G "$user" -u "$contract_host_uid" "$contract_user"
else
    contract_host_gid=$(id -g "$user")
    useradd --shell /usr/sbin/nologin -M -g "$contract_host_gid" -u "$contract_host_uid" "$contract_user"
fi

usermod --lock "$contract_user"
echo "Created '$contract_user' contract user."

user_id=$(id -u "$user")
user_runtime_dir="/run/user/$user_id"
dockerd_socket="unix://$user_runtime_dir/docker.sock"

# Setup user cgroup.
! (cgcreate -g cpu:$user$cgroupsuffix &&
    echo "1000000" >/sys/fs/cgroup/cpu/$user$cgroupsuffix/cpu.cfs_period_us &&
    echo "$cpu" >/sys/fs/cgroup/cpu/$user$cgroupsuffix/cpu.cfs_quota_us) && rollback "CGROUP_CPU_CREAT"
! (cgcreate -g memory:$user$cgroupsuffix &&
    echo "${memory}K" >/sys/fs/cgroup/memory/$user$cgroupsuffix/memory.limit_in_bytes &&
    echo "${swapmem}K" >/sys/fs/cgroup/memory/$user$cgroupsuffix/memory.memsw.limit_in_bytes) && rollback "CGROUP_MEM_CREAT"

# Adding disk quota to the group.
setquota -g -F vfsv0 "$user" "$disk" "$disk" 0 0 /

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

mkdir "$user_dir"/.config/systemd/user/$docker_service.d
echo "[Service]
    Environment='DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=slirp4netns'" >"$user_dir"/.config/systemd/user/$docker_service.d/override.conf
sudo -u "$user" XDG_RUNTIME_DIR="$user_runtime_dir" systemctl --user restart $docker_service
service_ready $docker_service || rollback "NO_DOCKERSVC"

echo "Installed rootless dockerd."

echo "Adding hpfs services for the instance."

echo "[Unit]
Description=Running and monitoring contract fs.
StartLimitIntervalSec=0
[Service]
Type=simple
ExecStartPre=/bin/bash -c '( ! /bin/grep -qs $user_dir/$contract_dir/contract_fs/mnt /proc/mounts ) || /bin/fusermount -u $user_dir/$contract_dir/contract_fs/mnt'
EnvironmentFile=-$user_dir/.serviceconf
ExecStart=/bin/bash -c '$script_dir/hpfs fs -f $user_dir/$contract_dir/contract_fs -m $user_dir/$contract_dir/contract_fs/mnt -u $contract_host_uid:$contract_host_gid -t \${HPFS_TRACE}\$([ \$HPFS_MERGE = \"true\" ] && echo \" -g\")'
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target" >"$user_dir"/.config/systemd/user/contract_fs.service

echo "[Unit]
Description=Running and monitoring ledger fs.
StartLimitIntervalSec=0
[Service]
Type=simple
ExecStartPre=/bin/bash -c '( ! /bin/grep -qs $user_dir/$contract_dir/ledger_fs/mnt /proc/mounts ) || /bin/fusermount -u $user_dir/$contract_dir/ledger_fs/mnt'
EnvironmentFile=-$user_dir/.serviceconf
ExecStart=$script_dir/hpfs fs -f $user_dir/$contract_dir/ledger_fs -m $user_dir/$contract_dir/ledger_fs/mnt -t \${HPFS_TRACE} -g
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target" >"$user_dir"/.config/systemd/user/ledger_fs.service

sudo -u "$user" XDG_RUNTIME_DIR="$user_runtime_dir" systemctl --user daemon-reload

echo "$user_id,$user,$dockerd_socket,INST_SUC"
exit 0
