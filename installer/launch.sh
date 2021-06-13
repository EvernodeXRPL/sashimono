#!/bin/sh

# Users that sashimono agent and rootless docker will operate under.
sashimono_user=sashimono
docker_user=sashidocker
setup_dir=$(pwd)/setupfiles
sashimono_dir=/home/$sashimono_user/sashimono-agent
docker_dir=/home/$sashimono_user/docker

# Check if users already exists.
[ `id -u $sashimono_user 2>/dev/null || echo -1` -ge 0 ] && echo "User '$sashimono_user' already exists." && exit 1
[ `id -u $docker_user 2>/dev/null || echo -1` -ge 0 ] && echo "User '$docker_user' already exists." && exit 1

# Create users (Only sashimono user gets a home dir).
sudo useradd -m $sashimono_user
sudo useradd $docker_user

# Prevent log in.
sudo usermod -L $sashimono_user
sudo usermod -L $docker_user
echo "Created '$sashimono_user' and '$docker_user' users."

# Install curl if not exists (required to download installation artifacts).
[ ! command -v curl &> /dev/null ] && sudo apt-get install -y curl

# Execute installation script as sashimono user
echo "Installing as '$sashimono_user' user..."
sudo -u $sashimono_user bash -i -c "./install.sh $setup_dir $sashimono_dir $docker_dir"

# Update service unit definition with physical values.
sed -i 's?#run_as#?'"$docker_user"'?g' sashimono-docker.service
sed -i 's?#docker_dir#?'"$docker_dir"'?g' sashimono-docker.service

# Configure dockerd service startup.
sudo cp $setup_dir/sashimono-docker.service /etc/systemd/system/
sudo systemctl start sashimono-docker
sudo systemctl enable sashimono-docker