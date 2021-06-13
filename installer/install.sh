#!/bin/sh

# Users that sashimono agent and rootless docker will operate under.
sashimono_user=sashimono
sashimono_user_dir=/home/$sashimono_user
sashimono_agent_dir=$sashimono_user_dir/sashimono-agent
docker_user=sashidocker
docker_user_dir=/home/$docker_user
dockerd_service=sashimono-dockerd

# Check if users already exists.
[ `id -u $sashimono_user 2>/dev/null || echo -1` -ge 0 ] && echo "User '$sashimono_user' already exists." && exit 1
[ `id -u $docker_user 2>/dev/null || echo -1` -ge 0 ] && echo "User '$docker_user' already exists." && exit 1

# Install curl if not exists (required to download installation artifacts).
[ ! $(command -v curl &> /dev/null) ] && sudo apt-get install -y curl



# --------------------------------------
# Setup docker user and dockerd service.
# --------------------------------------
sudo useradd -m $docker_user
sudo usermod -L $docker_user # Prevent log in.
echo "Created '$docker_user' user."

# Download and extract Docker rootless package.
# This will extract the Docker rootless binaries at $docker_user_dir/bin
curl --silent -fSL https://get.docker.com/rootless | sudo -u $docker_user sh > /dev/null

# Setup rootless dockerd env variables.
sudo -u $docker_user echo "export XDG_RUNTIME_DIR=$docker_user_dir/.docker/run
export PATH=$docker_user_dir/bin:\$PATH
export DOCKER_HOST=unix://$docker_user_dir/.docker/run/docker.sock" > $docker_user_dir/.dockerd-vars

# Configure dockerd service unit.
sudo echo "[Unit]
Description=Sashimono rootless dockerd service
[Service]
User=$docker_user
Environment=\"BASH_ENV=$docker_user_dir/.dockerd-vars\"
WorkingDirectory=$docker_user_dir
ExecStart=bash -c $docker_user_dir/bin/dockerd-rootless.sh
[Install]
WantedBy=multi-user.target" > /etc/systemd/system/$dockerd_service.service
sudo systemctl daemon-reload
# Start the dockerd.
sudo systemctl start $dockerd_service
# Enable auto-start on bootup.
sudo systemctl enable $dockerd_service



# -------------------------------
# Setup Sashimono user and agent.
# -------------------------------
sudo useradd -m $sashimono_user
sudo usermod -L $sashimono_user # Prevent log in. 
echo "Created '$sashimono_user' user."

# Following two permissions are required for Sashimono to interact with the dockerd UNIX socket.
# Add sashimono user to docker user group.
sudo usermod -a -G $docker_user $sashimono_user
# Create docker run directory and assign execute permission for group.
sudo -u $docker_user sh -c "mkdir -p $docker_user_dir/.docker/run"
sudo chmod g+x $docker_user_dir/.docker/run

# Setup docker client for sashimono user.
sudo mkdir -p $sashimono_agent_dir
sudo cp $docker_user_dir/bin/docker $sashimono_agent_dir/
sudo chown --recursive $sashimono_user $sashimono_agent_dir