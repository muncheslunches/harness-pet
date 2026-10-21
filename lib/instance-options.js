const store = require('./store');

function duplicate(source, instances = [source]) {
  const fresh = store.newInstance(source.pet, source.harness);
  const inst = { ...JSON.parse(JSON.stringify(source)), uid: fresh.uid,
    experimentalDuplicate: true, duplicateOf: source.duplicateOf || source.uid, visible: true,
    instanceNumber: Math.max(1, ...instances.filter((i) => i.pet === source.pet).map((i) => i.instanceNumber || 1)) + 1 };
  return inst;
}

function numberDuplicates(instances) {
  const used = new Map();
  for (const inst of instances) {
    if (!used.has(inst.pet)) used.set(inst.pet, new Set([1]));
    if (inst.instanceNumber > 1) used.get(inst.pet).add(inst.instanceNumber);
  }
  for (const inst of instances) {
    if (!inst.experimentalDuplicate || inst.instanceNumber > 1) continue;
    const numbers = used.get(inst.pet);
    let n = 2;
    while (numbers.has(n)) n++;
    inst.instanceNumber = n;
    numbers.add(n);
  }
}

module.exports = { duplicate, numberDuplicates };
