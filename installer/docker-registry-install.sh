#!/bin/bash
# Sashimono private docker registry installation script.
# This acts as a pull-through cache to the public docker hub registry.

user=$DOCKER_REGISTRY_USER
port=$DOCKER_REGISTRY_PORT
hubregistry="https://index.docker.io"
user_dir=/home/$user

# Waits until a service becomes ready up to 3 seconds.
function service_ready() {
    local svcstat=""
    for ((i = 0; i < 30; i++)); do
        sleep 0.1
        svcstat=$(sudo -u "$user" XDG_RUNTIME_DIR="$user_runtime_dir" systemctl --user is-active $1)
        if [ "$svcstat" == "active" ] ; then
            return 0    # Success
        fi
    done
    return 1 # Error
}

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
export PATH=$DOCKER_BIN:\$PATH
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
sudo -H -u "$user" PATH="$DOCKER_BIN":"$PATH" XDG_RUNTIME_DIR="$user_runtime_dir" "$DOCKER_BIN"/dockerd-rootless-setuptool.sh install
service_ready "docker.service" || rollback "NO_DOCKERSVC"

echo "Installed rootless dockerd for docker registry."

# Run the docker registry container on specified port.
DOCKER_HOST=$dockerd_socket $DOCKER_BIN/docker run -d -p $port:5000 --restart=always --name registry -e REGISTRY_PROXY_REMOTEURL=$hubregistry registry:2
echo "Docker registry listening at $port"

exit 0