import {
  DaemonSetList,
  StatefulSetList,
  DeploymentList,
  Deployment,
  DaemonSet,
  StatefulSet,
  ReplicaSetList,
  ControllerRevisionList,
} from 'kubernetes-types/apps/v1';

import axios, { parseAxiosError } from '@/portainer/services/axios';
import { EnvironmentId } from '@/react/portainer/environments/types';
import { isFulfilled } from '@/portainer/helpers/promise-utils';

import { parseKubernetesAxiosError } from '../axiosError';

import { getPod, getNamespacePods, patchPod } from './pod.service';
import { filterRevisionsByOwnerUid, getNakedPods } from './utils';
import {
  AppKind,
  Application,
  ApplicationList,
  ApplicationPatch,
} from './types';
import { appRevisionAnnotation } from './constants';

// This file contains services for Kubernetes apps/v1 resources (Deployments, DaemonSets, StatefulSets)

export async function getApplicationsForCluster(
  environmentId: EnvironmentId,
  namespaceNames?: string[]
) {
  if (!namespaceNames) {
    return [];
  }
  const applications = await Promise.all(
    namespaceNames.map((namespace) =>
      getApplicationsForNamespace(environmentId, namespace)
    )
  );
  return applications.flat();
}

// get a list of all Deployments, DaemonSets, StatefulSets and naked pods (https://portainer.atlassian.net/browse/CE-2) in one namespace
async function getApplicationsForNamespace(
  environmentId: EnvironmentId,
  namespace: string
) {
  const [deployments, daemonSets, statefulSets, pods] = await Promise.all([
    getApplicationsByKind<DeploymentList>(
      environmentId,
      namespace,
      'Deployment'
    ),
    getApplicationsByKind<DaemonSetList>(environmentId, namespace, 'DaemonSet'),
    getApplicationsByKind<StatefulSetList>(
      environmentId,
      namespace,
      'StatefulSet'
    ),
    getNamespacePods(environmentId, namespace),
  ]);
  // find all pods which are 'naked' (not owned by a deployment, daemonset or statefulset)
  const nakedPods = getNakedPods(pods, deployments, daemonSets, statefulSets);
  return [...deployments, ...daemonSets, ...statefulSets, ...nakedPods];
}

// if not known, get the type of an application (Deployment, DaemonSet, StatefulSet or naked pod) by name
export async function getApplication<
  T extends Application | string = Application,
>(
  environmentId: EnvironmentId,
  namespace: string,
  name: string,
  appKind?: AppKind,
  yaml?: boolean
) {
  // if resourceType is known, get the application by type and name
  if (appKind) {
    switch (appKind) {
      case 'Deployment':
      case 'DaemonSet':
      case 'StatefulSet':
        return getApplicationByKind<T>(
          environmentId,
          namespace,
          appKind,
          name,
          yaml
        );
      case 'Pod':
        return getPod(environmentId, namespace, name, yaml);
      default:
        throw new Error('Unknown resource type');
    }
  }

  // if resourceType is not known, get the application by name and return the first one that is fulfilled
  const [deployment, daemonSet, statefulSet, pod] = await Promise.allSettled([
    getApplicationByKind<Deployment>(
      environmentId,
      namespace,
      'Deployment',
      name,
      yaml
    ),
    getApplicationByKind<DaemonSet>(
      environmentId,
      namespace,
      'DaemonSet',
      name,
      yaml
    ),
    getApplicationByKind<StatefulSet>(
      environmentId,
      namespace,
      'StatefulSet',
      name,
      yaml
    ),
    getPod(environmentId, namespace, name, yaml),
  ]);

  if (isFulfilled(deployment)) {
    return deployment.value;
  }
  if (isFulfilled(daemonSet)) {
    return daemonSet.value;
  }
  if (isFulfilled(statefulSet)) {
    return statefulSet.value;
  }
  if (isFulfilled(pod)) {
    return pod.value;
  }
  throw new Error('Unable to retrieve application');
}

export async function patchApplication(
  environmentId: EnvironmentId,
  namespace: string,
  appKind: AppKind,
  name: string,
  patch: ApplicationPatch
) {
  switch (appKind) {
    case 'Deployment':
      return patchApplicationByKind<Deployment>(
        environmentId,
        namespace,
        appKind,
        name,
        patch
      );
    case 'DaemonSet':
      return patchApplicationByKind<DaemonSet>(
        environmentId,
        namespace,
        appKind,
        name,
        patch,
        'application/strategic-merge-patch+json'
      );
    case 'StatefulSet':
      return patchApplicationByKind<StatefulSet>(
        environmentId,
        namespace,
        appKind,
        name,
        patch,
        'application/strategic-merge-patch+json'
      );
    case 'Pod':
      return patchPod(environmentId, namespace, name, patch);
    default:
      throw new Error(`Unknown application kind ${appKind}`);
  }
}

async function patchApplicationByKind<T extends Application>(
  environmentId: EnvironmentId,
  namespace: string,
  appKind: 'Deployment' | 'DaemonSet' | 'StatefulSet',
  name: string,
  patch: ApplicationPatch,
  contentType = 'application/json-patch+json'
) {
  try {
    const res = await axios.patch<T>(
      buildUrl(environmentId, namespace, `${appKind}s`, `${name}sd`),
      patch,
      {
        headers: {
          'Content-Type': contentType,
        },
      }
    );
    return res;
  } catch (e) {
    throw parseKubernetesAxiosError(e, 'Unable to patch application');
  }
}

async function getApplicationByKind<
  T extends Application | string = Application,
>(
  environmentId: EnvironmentId,
  namespace: string,
  appKind: 'Deployment' | 'DaemonSet' | 'StatefulSet',
  name: string,
  yaml?: boolean
) {
  try {
    const { data } = await axios.get<T>(
      buildUrl(environmentId, namespace, `${appKind}s`, name),
      {
        headers: { Accept: yaml ? 'application/yaml' : 'application/json' },
      }
    );
    return data;
  } catch (e) {
    throw parseKubernetesAxiosError(e, 'Unable to retrieve application');
  }
}

async function getApplicationsByKind<T extends ApplicationList>(
  environmentId: EnvironmentId,
  namespace: string,
  appKind: 'Deployment' | 'DaemonSet' | 'StatefulSet'
) {
  try {
    const { data } = await axios.get<T>(
      buildUrl(environmentId, namespace, `${appKind}s`)
    );
    const items = (data.items || []).map((app) => ({
      ...app,
      kind: appKind,
      apiVersion: data.apiVersion,
    }));
    return items as T['items'];
  } catch (e) {
    throw parseKubernetesAxiosError(
      e,
      `Unable to retrieve ${appKind}s in namespace '${namespace}'`
    );
  }
}

export async function getApplicationRevisionList(
  environmentId: EnvironmentId,
  namespace: string,
  deploymentUid?: string,
  appKind?: AppKind,
  labelSelector?: string
) {
  if (!deploymentUid) {
    throw new Error('deploymentUid is required');
  }
  try {
    switch (appKind) {
      case 'Deployment': {
        const replicaSetList = await getReplicaSetList(
          environmentId,
          namespace,
          labelSelector
        );
        const replicaSets = replicaSetList.items;
        // keep only replicaset(s) which are owned by the deployment with the given uid
        const replicaSetsWithOwnerId = filterRevisionsByOwnerUid(
          replicaSets,
          deploymentUid
        );
        // keep only replicaset(s) that have been a version of the Deployment
        const replicaSetsWithRevisionAnnotations =
          replicaSetsWithOwnerId.filter(
            (rs) => !!rs.metadata?.annotations?.[appRevisionAnnotation]
          );

        return {
          ...replicaSetList,
          items: replicaSetsWithRevisionAnnotations,
        } as ReplicaSetList;
      }
      case 'DaemonSet':
      case 'StatefulSet': {
        const controllerRevisionList = await getControllerRevisionList(
          environmentId,
          namespace,
          labelSelector
        );
        const controllerRevisions = controllerRevisionList.items;
        // ensure the controller reference(s) is owned by the deployment with the given uid
        const controllerRevisionsWithOwnerId = filterRevisionsByOwnerUid(
          controllerRevisions,
          deploymentUid
        );

        return {
          ...controllerRevisionList,
          items: controllerRevisionsWithOwnerId,
        } as ControllerRevisionList;
      }
      default:
        throw new Error(`Unknown application kind ${appKind}`);
    }
  } catch (e) {
    throw parseAxiosError(
      e as Error,
      `Unable to retrieve revisions for ${appKind}`
    );
  }
}

export async function getReplicaSetList(
  environmentId: EnvironmentId,
  namespace: string,
  labelSelector?: string
) {
  try {
    const { data } = await axios.get<ReplicaSetList>(
      buildUrl(environmentId, namespace, 'ReplicaSets'),
      {
        params: {
          labelSelector,
        },
      }
    );
    return data;
  } catch (e) {
    throw parseKubernetesAxiosError(e, 'Unable to retrieve ReplicaSets');
  }
}

export async function getControllerRevisionList(
  environmentId: EnvironmentId,
  namespace: string,
  labelSelector?: string
) {
  try {
    const { data } = await axios.get<ControllerRevisionList>(
      buildUrl(environmentId, namespace, 'ControllerRevisions'),
      {
        params: {
          labelSelector,
        },
      }
    );
    return data;
  } catch (e) {
    throw parseKubernetesAxiosError(
      e,
      'Unable to retrieve ControllerRevisions'
    );
  }
}

function buildUrl(
  environmentId: EnvironmentId,
  namespace: string,
  appKind:
    | 'Deployments'
    | 'DaemonSets'
    | 'StatefulSets'
    | 'ReplicaSets'
    | 'ControllerRevisions',
  name?: string
) {
  let baseUrl = `/endpoints/${environmentId}/kubernetes/apis/apps/v1/namespaces/${namespace}/${appKind.toLowerCase()}`;
  if (name) {
    baseUrl += `/${name}`;
  }
  return baseUrl;
}
