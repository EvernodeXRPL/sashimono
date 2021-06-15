#!/bin/sh
# Sashimono installation script.

sashimono_user=sashimono
sashimono_user_dir=/home/$sashimono_user
sashimono_agent_dir=$sashimono_user_dir/sashimono-agent
dockerd_user=sashidockerd
dockerd_user_dir=/home/$dockerd_user

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
dockerd_socket=unix://$dockerd_user_runtime_dir/docker.sock

# Create new daemon config to disable dockerd inter-container communication.
sudo -u $dockerd_user mkdir -p $dockerd_user_dir/.config/docker
echo '{"icc":false}' | sudo -u $dockerd_user tee $dockerd_user_dir/.config/docker/daemon.json >/dev/null

# Download and install rootless dockerd.
sudo loginctl enable-linger $dockerd_user
echo "Installing rootless dockerd..."
curl --silent -fSL https://get.docker.com/rootless | sudo -u $dockerd_user XDG_RUNTIME_DIR=$dockerd_user_runtime_dir sh > /dev/null
echo "Installed rootless dockerd."

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
# Assign group execute permission for group dockerd runtime dir.
sudo chmod g+x $dockerd_user_runtime_dir

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
echo "Configured docker client context sashidockerctx"

# Set PATH for convenience during interactive shell sessions.
echo "export PATH=$sashimono_agent_dir:\$PATH" >>$sashimono_user_dir/.bashrc

echo "Done."
