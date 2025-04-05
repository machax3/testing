"use strict";
const Cell = require("./Cell");

class EjectedMass extends Cell {
    constructor(gameServer, owner, position, size) {
        super(gameServer, owner, position, size);
        this.cellType = 3;
	this.ejector = null; // This will store the ID of the player who ejected this mass
    }
    onAdd(gameServer) {
        gameServer.nodesEject.push(this);
    }
    onRemove(gameServer) {
        let index = gameServer.nodesEject.indexOf(this);
        if (index !== -1) gameServer.nodesEject.splice(index, 1);
    }
}

module.exports = EjectedMass;
