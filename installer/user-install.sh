#!/bin/bash
# Sashimono instance user installation script.

# $1 - A number with 25 or less digits.
[ -z "$1" ] && echo "ARGS,RESULT_ERR" && exit 1
[ ${#1} -gt 25 ] && echo "ARGS,RESULT_ERR" && exit 1
[[ "$1" =~ [^0-9] ]] && echo "ARGS,RESULT_ERR" && exit 1

user="sashi$1"
user_dir=/home/$user
docker_bin=/usr/bin/sashimono-dockerbin

# Check if users already exists.
[ `id -u $user 2>/dev/null || echo -1` -ge 0 ] && echo "HAS_USER,RESULT_ERR" && exit 1

function rollback() {
    echo "Rolling back user installation."
    sleep 1
    $(pwd)/user-uninstall.sh $1
    echo "Rolled back the installation."
}

# Setup user and dockerd service.
useradd --shell /usr/sbin/nologin -m $user
usermod --lock $user
loginctl enable-linger $user # Enable lingering to support rootless dockerd service installation.
chmod o-rwx $user_dir
echo "Created '$user' user."

user_id=$(id -u $user)
user_runtime_dir="/run/user/$user_id"
dockerd_socket="unix://$user_runtime_dir/docker.sock"

# Setup env variables for the user.
echo "
export XDG_RUNTIME_DIR=$user_runtime_dir
export PATH=$docker_bin:\$PATH
export DOCKER_HOST=$dockerd_socket" >>$user_dir/.bashrc
echo "Updated user .bashrc."

echo "Installing rootless dockerd for user."
sleep 2 # Wait some time for the user profile environment to be functional.
sudo -u $user bash -i -c "$docker_bin/dockerd-rootless-setuptool.sh install"

svcstat=$(sudo -u $user XDG_RUNTIME_DIR=$user_runtime_dir systemctl --user is-active docker.service)
[ "$svcstat" != "active" ] && rollback $1 && echo "NO_SERVICE,RESULT_ERR" && exit 1

echo "Installed rootless dockerd."
echo "$user_id,$user,$dockerd_socket,RESULT_SUC"
exit 0
