#!/bin/sh

# Users that sashimono agent and rootless docker will operate under.
sashimono_user=sashimono
docker_user=sashidocker
setup_dir=$(pwd)/setupfiles
sashimono_dir=/home/$sashimono_user/sashimono-agent
docker_user_dir=/home/$docker_user

# Check if users already exists.
[ `id -u $sashimono_user 2>/dev/null || echo -1` -ge 0 ] && echo "User '$sashimono_user' already exists." && exit 1
[ `id -u $docker_user 2>/dev/null || echo -1` -ge 0 ] && echo "User '$docker_user' already exists." && exit 1

# Create users.

sudo useradd -m $sashimono_user
sudo usermod -L $sashimono_user # Prevent log in. 
echo "Created '$sashimono_user' user."

sudo useradd -m $docker_user
sudo usermod -L $docker_user # Prevent log in.
echo "Created '$docker_user' user."

# Install curl if not exists (required to download installation artifacts).
[ ! $(command -v curl &> /dev/null) ] && sudo apt-get install -y curl

# Download and extract Docker rootless package.
# This will extract the Docker rootless binaries at $docker_user_dir/bin
curl --silent -fSL https://get.docker.com/rootless | sudo -u $docker_user sh > /dev/null

# Set user permissions.
sudo cp $setup_dir/run-dockerd.sh $docker_user_dir/
sudo chown $docker_user $docker_user_dir/run-dockerd.sh

# Update service unit definition with physical values.
sed -i 's?#run_as#?'"$docker_user"'?g' $setup_dir/sashimono-docker.service
sed -i 's?#work_dir#?'"$docker_user_dir"'?g' $setup_dir/sashimono-docker.service

# Configure dockerd service startup.
sudo cp $setup_dir/sashimono-docker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start sashimono-docker
sudo systemctl enable sashimono-docker
