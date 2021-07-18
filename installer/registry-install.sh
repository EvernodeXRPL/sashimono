#!/bin/bash
# Sashimono docker registry installation script.

docker_bin=$1
user=$2
port=4444
hubacc="hotpocketdev"
images=("sashimono:hp-ubt.20.04" "sashimono:hp-ubt.20.04-njs.14")
user_dir=/home/$user

# Check if users already exists.
[ "$(id -u "$user" 2>/dev/null || echo -1)" -ge 0 ] && echo "$user already exists." && exit 1

useradd --shell /usr/sbin/nologin -m "$user"
usermod --lock "$user"
loginctl enable-linger "$user" # Enable lingering to support rootless dockerd service installation.
chmod o-rwx "$user_dir"
echo "Created '$user' user."

user_id=$(id -u "$user")
user_runtime_dir="/run/user/$user_id"
dockerd_socket="unix://$user_runtime_dir/docker.sock"

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

echo "Installed rootless dockerd for docker registry."

# Run the docker registry container on port 4444
DOCKER_HOST=$dockerd_socket $docker_bin/docker run -d -p $port:5000 --restart=always --name registry registry:2

# Prefetch the required docker images.
echo "Pulling Sashimono base contract images."
for img in ${images[@]}; do
    DOCKER_HOST=$dockerd_socket $docker_bin/docker pull $hubacc/$img
    DOCKER_HOST=$dockerd_socket $docker_bin/docker tag $hubacc/$img localhost:$port/$img
done

exit 0