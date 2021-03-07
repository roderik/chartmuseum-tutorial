import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as eks from '@pulumi/eks';
import * as k8s from '@pulumi/kubernetes';
import * as cloudflare from '@pulumi/cloudflare';

const name = 'chartmuseum';

// Create an EKS cluster
const cluster = new eks.Cluster(name, {
  instanceType: 't2.medium',
  desiredCapacity: 1,
  minSize: 1,
  maxSize: 2,
});

// Export the clusters' kubeconfig.
export const kubeconfig = cluster.kubeconfig;

// Create a k8s provider
const provider = new k8s.Provider('k8s', { kubeconfig });

// Setup a namespace

new k8s.core.v1.Namespace(`${name}-namespace`, { metadata: { name } }, { provider });

// Get access to the config
const config = new pulumi.Config();

// Deploy an ingress controller into it
const nginxIngress = new k8s.helm.v3.Chart(
  `${name}-ingress`,
  {
    chart: 'ingress-nginx',
    version: '3.15.2',
    fetchOpts: {
      repo: config
        .requireSecret('chartmuseumPass')
        .apply(
          (password) => `https://${config.require('chartmuseumUser')}:${password}@charts.vanderveer.be/ingress-nginx`
        ),
    },
    namespace: name,
    values: {
      controller: {
        scope: {
          enabled: true,
        },
        replicaCount: 2,
        metrics: {
          enabled: true,
        },
        admissionWebhooks: {
          enabled: false,
        },
      },
    },
  },
  {
    provider,
    ignoreChanges: ['status', 'metadata'],
  }
);

// Fetch the ingress URL from the service

const controllerService = nginxIngress.getResource('v1/Service', name, `${name}-ingress-ingress-nginx-controller`);

const ingressUrl = controllerService.status.apply((status) => status.loadBalancer.ingress[0].hostname);

// Get access to the config
const awsConfig = new pulumi.Config('aws');

// Create a domainname for this ingress using Cloudflare
new cloudflare.Record(`${name}-dns`, {
  name: `charts`,
  zoneId: config.requireSecret('zoneId'),
  type: 'CNAME',
  value: ingressUrl,
  proxied: true,
});

// Create the S3 bucket to store the charts
const bucket = new aws.s3.Bucket(`${name}-bucket`);

// Deploy Chartmuseum
new k8s.helm.v3.Chart(
  `chartmuseum`,
  {
    chart: 'chartmuseum',
    version: '2.15.0',
    fetchOpts: {
      repo: config
        .requireSecret('chartmuseumPass')
        .apply(
          (password) => `https://${config.require('chartmuseumUser')}:${password}@charts.vanderveer.be/chartmuseum`
        ),
    },
    namespace: name,
    values: {
      ingress: {
        enabled: true,
        annotations: {
          'kubernetes.io/ingress.class': 'nginx',
          'nginx.ingress.kubernetes.io/proxy-body-size': '100m',
          'nginx.ingress.kubernetes.io/enable-cors': 'true',
          'nginx.ingress.kubernetes.io/cors-allow-headers':
            'DNT,X-CustomHeader,Keep-Alive,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Authorization,X-Apollo-Tracing',
        },
        hosts: [
          {
            name: 'charts.vanderveer.be',
            path: '/',
          },
        ],
      },
      env: {
        open: {
          STORAGE: 'amazon',
          STORAGE_AMAZON_BUCKET: bucket.bucket.apply((bucket) => bucket),
          STORAGE_AMAZON_REGION: awsConfig.require('region'),
          DEBUG: true,
          DISABLE_API: false,
          ALLOW_OVERWRITE: true,
          AUTH_ANONYMOUS_GET: true,
          DEPTH: 1,
        },
        secret: {
          AWS_ACCESS_KEY_ID: awsConfig.requireSecret('accessKey'),
          AWS_SECRET_ACCESS_KEY: awsConfig.requireSecret('secretKey'),
          BASIC_AUTH_USER: config.require('chartmuseumUser'),
          BASIC_AUTH_PASS: config.requireSecret('chartmuseumPass'),
        },
      },
    },
  },
  { provider }
);
