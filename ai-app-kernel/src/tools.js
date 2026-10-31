const DB_TOOLS = [
  {
    name: 'app_schema',
    description: 'Read the app data model and available collections/tables.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'app_capabilities',
    description: 'List actions the AI may call to control this app.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'db_list',
    description: 'List records from a collection/table. Optional exact-match filter.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        filter: { type: 'object' },
      },
      required: ['collection'],
    },
  },
  {
    name: 'db_get',
    description: 'Get one record by id.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['collection', 'id'],
    },
  },
  {
    name: 'db_put',
    description: 'Create or update one record. Must include id when updating.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        record: { type: 'object' },
      },
      required: ['collection', 'record'],
    },
  },
  {
    name: 'db_delete',
    description: 'Delete one record by id.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['collection', 'id'],
    },
  },
  {
    name: 'app_invoke',
    description: 'Run a registered app action by name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        args: { type: 'object' },
      },
      required: ['name'],
    },
  },
];

export function kernelTools() {
  return DB_TOOLS;
}

export async function runTool(name, args, { store, schema, actions, ctx }) {
  if (name === 'app_schema') return { schema, collections: await store.listCollections() };
  if (name === 'app_capabilities') return { actions: actions.list() };
  if (name === 'db_list') return { items: await store.list(args.collection, args.filter || {}) };
  if (name === 'db_get') return { item: await store.get(args.collection, args.id) };
  if (name === 'db_put') {
    assertAllowed(schema, args.collection);
    return { item: await store.put(args.collection, args.record || {}) };
  }
  if (name === 'db_delete') {
    assertAllowed(schema, args.collection);
    return store.delete(args.collection, args.id);
  }
  if (name === 'app_invoke') return actions.invoke(args.name, args.args || {}, ctx);
  throw new Error(`Unknown tool: ${name}`);
}

function assertAllowed(schema, collection) {
  const names = (schema?.collections || []).map((c) => c.name);
  if (names.length && !names.includes(collection)) {
    throw new Error(`Collection "${collection}" is not in the app schema.`);
  }
}
