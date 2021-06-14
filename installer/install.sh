#!/bin/sh
# Sashimono installation script.

sashimono_user=sashimono
sashimono_user_dir=/home/$sashimono_user
sashimono_agent_dir=$sashimono_user_dir/sashimono-agent
dockerd_user=sashidockerd
dockerd_user_dir=/home/$dockerd_user
dockerd_service=sashimono-dockerd
dockerd_socket=unix://$dockerd_user_dir/.docker/run/docker.sock

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
echo "Created '$dockerd_user' user."

# Download and extract Docker rootless package.
# This will extract the Docker rootless binaries at $dockerd_user_dir/bin
curl --silent -fSL https://get.docker.com/rootless | sudo -u $dockerd_user sh > /dev/null
echo "Installed rootless dockerd at $dockerd_user_dir/bin"

# Setup rootless dockerd env variables.
echo "export XDG_RUNTIME_DIR=$dockerd_user_dir/.docker/run
export PATH=$dockerd_user_dir/bin:\$PATH
export DOCKER_HOST=$dockerd_socket" | sudo -u $dockerd_user tee $dockerd_user_dir/.dockerd-vars >/dev/null

# Configure dockerd service unit.
# (Using --icc=false for docker daemon to prevent inter-container communication)
sudo echo "[Unit]
Description=Sashimono rootless dockerd service
[Service]
User=$dockerd_user
Environment=\"BASH_ENV=$dockerd_user_dir/.dockerd-vars\"
WorkingDirectory=$dockerd_user_dir
ExecStart=bash -c '$dockerd_user_dir/bin/dockerd-rootless.sh --icc=false'
[Install]
WantedBy=multi-user.target" > /etc/systemd/system/$dockerd_service.service
sudo systemctl daemon-reload
# Start the dockerd.
sudo systemctl start $dockerd_service
# Enable auto-start on bootup.
sudo systemctl enable $dockerd_service
echo "Configured $dockerd_service service."


# --------------------------------------
# Setup Sashimono user and agent.
# --------------------------------------
sudo useradd --shell /usr/sbin/nologin -m $sashimono_user
sudo usermod --lock $sashimono_user
echo "Created '$sashimono_user' user."

# Following two permissions are required for Sashimono to interact with the dockerd UNIX socket.
# Add sashimono user to docker user group.
sudo usermod -a -G $dockerd_user $sashimono_user
# Create docker run directory and assign execute permission for group.
sudo -u $dockerd_user sh -c "mkdir -p $dockerd_user_dir/.docker/run"
sudo chmod g+x $dockerd_user_dir/.docker/run

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
