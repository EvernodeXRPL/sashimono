#!/bin/sh
# Sashimono instance user installation script.

# $1 - 32-character lowercase user GUID
[ -z "$1" ] && echo '{"error":"no_guid"}' && exit 0
[ ${#1} -ne 32 ] && echo '{"error":"invalid_len"}' && exit 0
[[ "$1" =~ [^a-z0-9] ]] && echo '{"error":"invalid_format"}' && exit 0

user="sashi$1"
user_dir=/home/$user

# Check if users already exists.
[ `id -u $user 2>/dev/null || echo -1` -ge 0 ] && echo '{"error":"no_user_id"}' && exit 0

# --------------------------------------
# Setup user and dockerd service.
# --------------------------------------
useradd --shell /usr/sbin/nologin -m $user
usermod --lock $user
loginctl enable-linger $user # Enable lingering to support rootless dockerd service installation.
chmod o-rwx $user_dir

user_id=$(id -u $user)
user_runtime_dir="/run/user/$user_id"
dockerd_socket="unix://$user_runtime_dir/docker.sock"

# Download and install rootless dockerd.
loginctl enable-linger $user
curl --silent -fSL https://get.docker.com/rootless | sudo -u $user XDG_RUNTIME_DIR=$user_runtime_dir sh > /dev/null

# Setup env variables for the user.
echo "
export XDG_RUNTIME_DIR=$user_runtime_dir
export PATH=$user_dir/bin:\$PATH
export DOCKER_HOST=$dockerd_socket" >>$user_dir/.bashrc

echo '{""userid":'$user_id',"username":"'$user'","docker_host": "'$dockerd_socket'"'
exit 0
