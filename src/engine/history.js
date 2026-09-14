export class AddStrokeCommand {
  constructor(nodeId, stroke) {
    this.nodeId = nodeId;
    this.stroke = stroke;
    this.description = 'Add Stroke';
  }

  execute(scene) {
    const node = scene.getNode(this.nodeId);
    if (node) node.addStroke(this.stroke);
  }

  undo(scene) {
    const node = scene.getNode(this.nodeId);
    if (node) node.removeStroke(this.stroke.id);
  }
}

export class AddImageCommand {
  constructor(nodeId, imageElement) {
    this.nodeId = nodeId;
    this.imageElement = imageElement;
    this.description = 'Add Image';
  }

  execute(scene) {
    const node = scene.getNode(this.nodeId);
    if (node) node.addImage(this.imageElement);
  }

  undo(scene) {
    const node = scene.getNode(this.nodeId);
    if (node) node.removeImage(this.imageElement.id);
  }
}

export class EraseCommand {
  constructor(nodeId, removedStrokes, addedStrokes = []) {
    this.nodeId = nodeId;
    this.removedStrokes = removedStrokes;
    this.addedStrokes = addedStrokes;
    this.description = 'Erase';
  }

  execute(scene) {
    const node = scene.getNode(this.nodeId);
    if (!node) return;
    const removedSet = new Set(this.removedStrokes.map((s) => s.id));
    node.elements = node.elements.filter((s) => !removedSet.has(s.id));
    for (const sub of this.addedStrokes) {
      node.addStroke(sub);
    }
  }

  undo(scene) {
    const node = scene.getNode(this.nodeId);
    if (!node) return;
    const addedSet = new Set(this.addedStrokes.map((s) => s.id));
    node.elements = node.elements.filter((s) => !addedSet.has(s.id));
    for (const orig of this.removedStrokes) {
      node.addStroke(orig);
    }
  }
}

export class CreateNodeCommand {
  constructor(parentId, node) {
    this.parentId = parentId;
    this.node = node;
    this.description = 'Create Canvas';
  }

  execute(scene) {
    const parent = scene.getNode(this.parentId);
    if (parent) parent.addChild(this.node);
  }

  undo(scene) {
    const parent = scene.getNode(this.parentId);
    if (parent) parent.removeChild(this.node.id);
  }
}

export class TransformNodeCommand {
  constructor(nodeId, oldTransform, newTransform) {
    this.nodeId = nodeId;
    this.oldTransform = oldTransform;
    this.newTransform = newTransform;
    this.description = 'Move Canvas';
  }

  execute(scene) {
    const node = scene.getNode(this.nodeId);
    if (node) node.transform = this.newTransform;
  }

  undo(scene) {
    const node = scene.getNode(this.nodeId);
    if (node) node.transform = this.oldTransform;
  }
}

export class BatchCommand {
  constructor(description, commands) {
    this.description = description;
    this.commands = commands;
  }

  execute(scene) {
    for (const cmd of this.commands) {
      cmd.execute(scene);
    }
  }

  undo(scene) {
    for (let i = this.commands.length - 1; i >= 0; i--) {
      this.commands[i].undo(scene);
    }
  }
}

export class HistoryManager {
  constructor(maxCapacity = 50) {
    this.undoStack = [];
    this.redoStack = [];
    this.maxCapacity = maxCapacity;
  }

  execute(command, scene) {
    command.execute(scene);
    this.undoStack.push(command);
    this.redoStack = [];
    if (this.undoStack.length > this.maxCapacity) {
      this.undoStack.shift();
    }
  }

  undo(scene) {
    if (this.undoStack.length === 0) return false;
    const cmd = this.undoStack.pop();
    cmd.undo(scene);
    this.redoStack.push(cmd);
    return true;
  }

  redo(scene) {
    if (this.redoStack.length === 0) return false;
    const cmd = this.redoStack.pop();
    cmd.execute(scene);
    this.undoStack.push(cmd);
    return true;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}
