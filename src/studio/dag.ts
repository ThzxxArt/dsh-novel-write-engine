import { DirectedGraph } from 'graphology'
import { hasCycle, topologicalSort } from 'graphology-dag'
import { StudioError, STUDIO_ERROR_CODES } from '../contracts/errors.js'

export interface DagNode {
  id: string
  dependsOn: readonly string[]
}

/** Build and validate the task DAG. Cycles are a programming fault, never data. */
export function taskTopology(nodes: readonly DagNode[]): string[] {
  const graph = new DirectedGraph()
  for (const node of nodes) {
    if (graph.hasNode(node.id)) {
      throw new StudioError(
        STUDIO_ERROR_CODES.RUN_STATE_INVALID,
        `task dependency graph repeats node ${node.id}`,
      )
    }
    graph.addNode(node.id)
  }
  for (const node of nodes) {
    for (const dependency of new Set(node.dependsOn)) {
      if (!graph.hasNode(dependency)) {
        throw new StudioError(
          STUDIO_ERROR_CODES.TASK_STATE_INVALID,
          `task ${node.id} depends on unknown task ${dependency}`,
        )
      }
      graph.addEdge(dependency, node.id)
    }
  }
  if (hasCycle(graph)) {
    throw new StudioError(
      STUDIO_ERROR_CODES.RUN_STATE_INVALID,
      'task dependency graph contains a cycle',
      'fix the Director DAG; the scheduler refuses to guess an order',
    )
  }
  return topologicalSort(graph)
}

export function assertTaskDag(nodes: readonly DagNode[]): void {
  void taskTopology(nodes)
}
