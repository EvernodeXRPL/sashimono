#!/bin/sh
# Sashimono installation script.

sashimono_user=sashimono
sashimono_user_dir=/home/$sashimono_user
sashimono_agent_dir=$sashimono_user_dir/sashimono-agent
dockerd_user=sashidockerd
dockerd_user_dir=/home/$dockerd_user
dockerd_socket_dir=$dockerd_user_dir/.docker/run
dockerd_socket=unix://$dockerd_socket_dir/docker.sock
mod_netfilter=br_netfilter

# Check if users already exists.
[ `id -u $sashimono_user 2>/dev/null || echo -1` -ge 0 ] && echo "User '$sashimono_user' already exists." && exit 1
[ `id -u $dockerd_user 2>/dev/null || echo -1` -ge 0 ] && echo "User '$dockerd_user' already exists." && exit 1

# Install curl if not exists (required to download installation artifacts).
[ ! $(command -v curl &> /dev/null) ] && sudo apt-get install -y curl


# --------------------------------------
# Setup dockerd user and service.
# --------------------------------------
sudo useradd --shell /usr/sbin/nologin -m $dockerd_user
sudo usermod --lock $dockerd_user
sudo loginctl enable-linger $dockerd_user # Enable lingering to support rootless dockerd service installation.
echo "Created '$dockerd_user' user."

dockerd_user_runtime_dir=/run/user/$(id -u $dockerd_user)

# Download and install rootless dockerd.
sudo -u $dockerd_user mkdir -p $dockerd_socket_dir
sudo loginctl enable-linger $dockerd_user
echo "Installing rootless dockerd..."
curl --silent -fSL https://get.docker.com/rootless | sudo -u $dockerd_user XDG_RUNTIME_DIR=$dockerd_user_runtime_dir sh > /dev/null
echo "Installed rootless dockerd."

# After installing rootless dockerd, we need to stop and restart the dockerd service with our own daemon config.

# Create new daemon config.
# - Disable dockerd inter-container communication.
# - Specify custom docker socket path. (So we can specify custom dir execute permission to user group)
sudo -u $dockerd_user mkdir -p $dockerd_user_dir/.config/docker
echo '{"icc":false,"hosts":["'$dockerd_socket'"]}' | sudo -u $dockerd_user tee $dockerd_user_dir/.config/docker/daemon.json >/dev/null

# We need br_netfilter kernel module to make icc=false work. Otherwise dockerd won't start.
echo "Checking for '$mod_netfilter' kernel module..."
modprobe -n --first-time $mod_netfilter && modprobe $mod_netfilter && echo "Adding $mod_netfilter to /etc/modules" && printf "\n$mod_netfilter\n" >>/etc/modules

# Stop and start the dockerd service.
sudo -u $dockerd_user XDG_RUNTIME_DIR=$dockerd_user_runtime_dir systemctl --user stop docker.service
sudo -u $dockerd_user XDG_RUNTIME_DIR=$dockerd_user_runtime_dir systemctl --user start docker.service
echo "Restarted dockerd service with Sashimono configuration."

# Setup env variables for dockerd user.
echo "
export XDG_RUNTIME_DIR=$dockerd_user_runtime_dir
export PATH=$dockerd_user_dir/bin:\$PATH
export DOCKER_HOST=$dockerd_socket" >>$dockerd_user_dir/.bashrc


# --------------------------------------
# Setup Sashimono user and agent.
# --------------------------------------
sudo useradd --shell /usr/sbin/nologin -m $sashimono_user
sudo usermod --lock $sashimono_user
echo "Created '$sashimono_user' user."

# Following two permissions are required for Sashimono to interact with the dockerd UNIX socket.
# Add sashimono user to docker user group.
sudo usermod -a -G $dockerd_user $sashimono_user
# Assign group execute permission for docker socket dir.
sudo chmod g+x $dockerd_socket_dir

# Setup sashimono agent directory.
sudo mkdir -p $sashimono_agent_dir
# Copy docker client for sashimono user.
sudo cp $dockerd_user_dir/bin/docker $sashimono_agent_dir/
# TODO: Copy sashimono agent binaries.
# Set owner and group to be sashimono user.
sudo chown --recursive $sashimono_user.$sashimono_user $sashimono_agent_dir
echo "Configured $sashimono_agent_dir"

# Configure docker client context.
sudo -u $sashimono_user $sashimono_agent_dir/docker context create sashidockerctx --docker host=$dockerd_socket >/dev/null
sudo -u $sashimono_user $sashimono_agent_dir/docker context use sashidockerctx >/dev/null

# Set PATH for convenience during interactive shell sessions.
echo "export PATH=$sashimono_agent_dir:\$PATH" >>$sashimono_user_dir/.bashrc

echo "Done."
