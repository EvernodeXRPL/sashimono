#!/bin/bash
# Sashimono instance user installation script.

# $1 - A number with 25 or less digits.
[ -z "$1" ] && echo "ARGS,INSTALL_ERR" && exit 1
[ ${#1} -gt 25 ] && echo "ARGS,INSTALL_ERR" && exit 1
[[ "$1" =~ [^0-9] ]] && echo "ARGS,INSTALL_ERR" && exit 1

user="sashi$1"
user_dir=/home/$user
docker_bin=/usr/bin/sashimono-dockerbin

# Check if users already exists.
[ `id -u $user 2>/dev/null || echo -1` -ge 0 ] && echo "USEREXISTS,INSTALL_ERR" && exit 1

# Setup user and dockerd service.
useradd --shell /usr/sbin/nologin -m $user
usermod --lock $user
loginctl enable-linger $user # Enable lingering to support rootless dockerd service installation.
chmod o-rwx $user_dir

user_id=$(id -u $user)
user_runtime_dir="/run/user/$user_id"
dockerd_socket="unix://$user_runtime_dir/docker.sock"

# Setup env variables for the user.
echo "
export XDG_RUNTIME_DIR=$user_runtime_dir
export PATH=$user_dir/bin:\$PATH
export DOCKER_HOST=$dockerd_socket" >>$user_dir/.bashrc

# Install rootless dockerd as instance user.
tmp=$(sudo -u $user mktemp -d)
echo "
export PATH=$docker_bin:\$PATH
$docker_bin/dockerd-rootless-setuptool.sh install" >$tmp/install.sh
chmod a+x $tmp/install.sh
sudo -u $user XDG_RUNTIME_DIR=$user_runtime_dir bash -c "$tmp/install.sh"
rm -r $tmp

echo "$user_id,$user,$dockerd_socket,INSTALL_SUC"
exit 0
