#!/bin/bash -ex

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd $DIR/../

trap "rm -f index.yaml" EXIT

get_all_tgzs() {
    mkdir -p mirror/$1
    helm repo add $1 https://${HELM_USERNAME}:${HELM_PASSWORD}@charts.vanderveer.be/$1
    local repo_url="$2"
    rm -f index.yaml
    wget $repo_url/index.yaml
    tgzs="$(ruby -ryaml -e "YAML.load_file('index.yaml')['entries'].each do |k,e|;for c in e;puts c['urls'][0];end;end")"

    pushd mirror/$1
    for tgz in $tgzs; do
        if [ ! -f "${tgz##*/}" ]; then
            wget $tgz
            helm push "${tgz##*/}" $1 --debug;
        fi
    done
    popd
}

get_all_tgzs ingress-nginx https://kubernetes.github.io/ingress-nginx
get_all_tgzs chartmuseum https://chartmuseum.github.io/charts