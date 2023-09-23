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
peer_port=$8
user_port=$9
docker_image=${10}
docker_registry=${11}
outbound_ipv6=${12}
outbound_net_interface=${13}

if [ -z "$cpu" ] || [ -z "$memory" ] || [ -z "$swapmem" ] || [ -z "$disk" ] || [ -z "$contract_dir" ] ||
    [ -z "$contract_uid" ] || [ -z "$contract_gid" ] || [ -z "$peer_port" ] || [ -z "$user_port" ] ||
    [ -z "$docker_image" ] || [ -z "$docker_registry" ] || [ -z "$outbound_ipv6" ] || [ -z "$outbound_net_interface" ]; then
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
docker_pull_timeout_secs=120
cleanup_script=$user_dir/uninstall_cleanup.sh

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

# Wait until daemon ready
function wait_for_dockerd() {
    # Retry for 5 times until dockerd is available.
    local i=0
    while true; do
        DOCKER_HOST=$dockerd_socket $docker_bin/docker version >/dev/null && return 0 # Success
        ((i++))
        echo "Docker daemon isn't available. Retrying $i..."
        [[ $i -ge 5 ]] && return 1 # Error
        sleep 1
    done
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
# Even though there's this "if not 0" condition, contract_gid will always be 0 since we are setting hp config's gid to 0 in instance creation.
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

echo "Adding disk quota to the group."
setquota -g -F vfsv0 "$user" "$disk" "$disk" 0 0 /
echo "Configured disk quota for the group."

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

echo "Allowing user and peer ports in firewall"
rule_list=$(sudo ufw status)
comment=$prefix-$contract_dir

# Add rules for user port.
sed -n -r -e "/${$user_port}\/tcp\s*ALLOW\s*Anywhere/{q100}" <<<"$rule_list"
res=$?
if [ ! $res -eq 100 ]; then
    user_port_comment=$comment-user
    echo "Adding new rule to allow user port for new instance from firewall."
    sudo ufw allow "$user_port"/tcp comment "$user_port_comment"
else
    echo "User port rule already exists. Skipping."
fi

# Add rules for peer port.
sed -n -r -e "/${$peer_port}\s*ALLOW\s*Anywhere/{q100}" <<<"$rule_list"
res=$?
if [ ! $res -eq 100 ]; then
    peer_port_comment=$comment-peer
    echo "Adding new rule to allow peer port for new instance from firewall."
    sudo ufw allow "$peer_port" comment "$peer_port_comment"
else
    echo "Peer port rule already exists. Skipping."
fi

echo "Installing rootless dockerd for user."
sudo -H -u "$user" PATH="$docker_bin":"$PATH" XDG_RUNTIME_DIR="$user_runtime_dir" "$docker_bin"/dockerd-rootless-setuptool.sh install

# Add environment variables as an override to docker service unit file.
echo "Applying $docker_service env overrides."
docker_service_override_conf="$user_dir/.config/systemd/user/$docker_service.d/override.conf"
sudo -H -u "$user" mkdir $user_dir/.config/systemd/user/$docker_service.d
sudo -H -u "$user" touch $docker_service_override_conf
echo "[Service]
    Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=slirp4netns" >$docker_service_override_conf

# We need to enable ipv6 configurations if outbound ipv6 address is specified.
if [ "$outbound_ipv6" != "-" ] && [ "$outbound_net_interface" != "-" ]; then
    
    # Pass the relevant ipv6 parameters to rootlesskit flags. rootlesskit will in turn pass these to slirp4nets.
    # Also apply ipv6 route configuration patch in the dockerd process namespace (credits: https://github.com/containers/podman/issues/15850#issuecomment-1320028298)
    echo "
    Environment=\"DOCKERD_ROOTLESS_ROOTLESSKIT_FLAGS=--ipv6 --outbound-addr6=$outbound_ipv6\"
    ExecStartPost=/bin/bash -c 'nsenter -U --preserve-credentials -n -t $""(pgrep -u $user dockerd) /bin/bash -c \"ip addr add fd00::100/64 dev tap0 && ip route add default via fd00::2 dev tap0\"'
    " >>$docker_service_override_conf

    # Set the predefined ipv6 parameters to docker daemon config.
    mkdir -p $user_dir/.config/docker
    echo "{
        \"experimental\": true,
        \"ipv6\": true,
        \"fixed-cidr-v6\": \"2001:db8:1::/64\",
        \"ip6tables\": true,
        \"mtu\": 65520
    }" >$user_dir/.config/docker/daemon.json
    
    # Add the outbound ipv6 address to the specified network interface.
    ip addr add $outbound_ipv6 dev $outbound_net_interface

    # Add instructions to the cleanup script so the outbound ip assignment will be removed upon user install.
    echo "ip addr del $outbound_ipv6 dev $outbound_net_interface" >>$cleanup_script
fi

# Overwrite docker-rootless cli args on the docker service unit file (ExecStart is not supported by override.conf).
echo "Applying $docker_service extra args."
exec_original="ExecStart=$docker_bin/dockerd-rootless.sh"
exec_replace="$exec_original --max-concurrent-downloads 1"
# Add private docker registry information.
[ "$docker_registry" != "-" ] && exec_replace="$exec_replace --registry-mirror http://$docker_registry --insecure-registry $docker_registry"
sed -i "s%$exec_original%$exec_replace%" $user_dir/.config/systemd/user/$docker_service

# Reload the docker service.
sudo -u "$user" XDG_RUNTIME_DIR="$user_runtime_dir" systemctl --user daemon-reload
sudo -u "$user" XDG_RUNTIME_DIR="$user_runtime_dir" systemctl --user restart $docker_service
service_ready $docker_service || rollback "NO_DOCKERSVC"
# Wait until docker daemon ready, If failed rollback.
! wait_for_dockerd && rollback "NO_DOCKERD"

echo "Installed rootless dockerd."

echo "Pulling the docker image $docker_image."
DOCKER_HOST="$dockerd_socket" timeout --foreground -v -s SIGINT "$docker_pull_timeout_secs"s "$docker_bin"/docker pull "$docker_image" || rollback "DOCKER_PULL"
echo "Docker image $docker_image pull complete."

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

# In the Sashimono configuration, CPU time is 1000000us Sashimono is given max_cpu_us out of it.
# Instance allocation is multiplied by number of cores to determined the number of cores per instance and devided by 10 since cfs_period_us is set to 100000us
cores=$(grep -c ^processor /proc/cpuinfo)
cpu_quota=$(expr $(expr $cores \* $cpu) / 10)
echo "Setting up user cgroup resources."
! (cgcreate -g cpu:$user$cgroupsuffix &&
    echo "100000" >/sys/fs/cgroup/cpu/$user$cgroupsuffix/cpu.cfs_period_us &&
    echo "$cpu_quota" >/sys/fs/cgroup/cpu/$user$cgroupsuffix/cpu.cfs_quota_us) && rollback "CGROUP_CPU_CREAT"
! (cgcreate -g memory:$user$cgroupsuffix &&
    echo "${memory}K" >/sys/fs/cgroup/memory/$user$cgroupsuffix/memory.limit_in_bytes &&
    echo "${swapmem}K" >/sys/fs/cgroup/memory/$user$cgroupsuffix/memory.memsw.limit_in_bytes) && rollback "CGROUP_MEM_CREAT"
echo "Configured user cgroup resources."

echo "$user_id,$user,$dockerd_socket,INST_SUC"
exit 0
