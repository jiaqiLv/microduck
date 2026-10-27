#!/usr/bin/env python3
"""Export the Microduck MJCF (MuJoCo) model to a glTF binary for the website.

Run inside the microduck container, which has mujoco + trimesh:

    DOCKER_HOST=unix:///var/run/docker-mjlab.sock docker exec microduck \\
      /workspace/src/microduck_rl/.venv/bin/python /workspace/tmp/duck3d/build_duck_glb.py

Why this and not the raw STLs: MuJoCo rewrites every mesh into its own inertia
frame at compile time, so `m.mesh_vert` is *not* the STL on disk. The geom's
pos/quat in the XML are authored against that rewritten buffer (verified via
`m.geom_aabb`, whose centre is 0 in the geom frame). Reading `m.mesh_vert` +
`m.geom_pos/quat` is therefore the only combination that reproduces exactly
what MuJoCo renders and what the policies were trained on.

Output:
    microduck.glb           node hierarchy = body hierarchy, one node per visual geom
    microduck-model.json    bodies / joints / sites / node table for the viewer
"""

import json
import os

import mujoco
import numpy as np
import trimesh

MODEL_DIR = "/workspace/src/microduck_rl/src/mjlab_microduck/robot/microduck"
XML = os.path.join(MODEL_DIR, "robot_walk.xml")
OUT_DIR = "/workspace/tmp/duck3d"
OUT_GLB = os.path.join(OUT_DIR, "microduck.glb")
OUT_JSON = os.path.join(OUT_DIR, "microduck-model.json")


def mat_from_pos_quat(pos, quat):
    """MuJoCo (w, x, y, z) quaternion + position -> 4x4 homogeneous matrix."""
    mat = np.eye(4)
    rot = np.zeros(9)
    mujoco.mju_quat2Mat(rot, np.asarray(quat, dtype=np.float64))
    mat[:3, :3] = rot.reshape(3, 3)
    mat[:3, 3] = pos
    return mat


def srgb_to_linear(c):
    c = float(c)
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material_for(name, rgba):
    """One PBR material per MJCF material; CAD parts read better with low metalness."""
    r, g, b, a = (srgb_to_linear(v) for v in rgba)
    metallic, roughness = 0.08, 0.62
    if "bearing" in name:
        metallic, roughness = 0.85, 0.28
    elif name.startswith("xl330"):
        metallic, roughness = 0.35, 0.45
    elif "pcb" in name or "elec" in name:
        metallic, roughness = 0.0, 0.85
    return trimesh.visual.material.PBRMaterial(
        name=name,
        baseColorFactor=[r, g, b, a],
        metallicFactor=metallic,
        roughnessFactor=roughness,
        doubleSided=False,
    )


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    model = mujoco.MjModel.from_xml_path(XML)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    scene = trimesh.Scene()
    scene.graph.update(frame_to="world", frame_from=None, matrix=np.eye(4))

    # ---- bodies: node per body, transform relative to its parent body
    bodies = []
    body_node = {}
    for i in range(model.nbody):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, i)
        parent = model.body_parentid[i]
        parent_node = "world" if parent == 0 else body_node[int(parent)]
        node = "body_" + name
        body_node[i] = node
        scene.graph.update(
            frame_to=node,
            frame_from=parent_node,
            matrix=mat_from_pos_quat(model.body_pos[i], model.body_quat[i]),
        )
        bodies.append(
            {
                "node": node,
                "name": name,
                "parent": None
                if parent == 0
                else mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, int(parent)),
            }
        )

    # ---- one trimesh geometry per unique mesh asset (geoms instance them)
    mesh_geom = {}
    for mesh_id in range(model.nmesh):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_MESH, mesh_id)
        adr, num = int(model.mesh_vertadr[mesh_id]), int(model.mesh_vertnum[mesh_id])
        fadr, fnum = int(model.mesh_faceadr[mesh_id]), int(model.mesh_facenum[mesh_id])
        verts = np.array(model.mesh_vert[adr : adr + num], dtype=np.float64)
        faces = np.array(model.mesh_face[fadr : fadr + fnum], dtype=np.int64)
        geom = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
        mesh_geom[mesh_id] = (f"mesh:{name}", geom)

    # ---- visual geoms (group 2 = the "visual" default class in this model)
    nodes = []
    for g in range(model.ngeom):
        if model.geom_group[g] != 2:
            continue
        if model.geom_type[g] != mujoco.mjtGeom.mjGEOM_MESH:
            raise SystemExit(f"visual geom {g} is not a mesh; extend the exporter")
        mesh_id = int(model.geom_dataid[g])
        mesh_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_MESH, mesh_id)
        geom_name, geom = mesh_geom[mesh_id]
        mat_id = int(model.geom_matid[g])
        mat_name = None
        if mat_id >= 0:
            mat_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_MATERIAL, mat_id) or mesh_name
            geom.visual = trimesh.visual.TextureVisuals(
                material=material_for(mat_name, model.mat_rgba[mat_id])
            )
        body = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, int(model.geom_bodyid[g]))
        node = f"geom_{g:02d}"
        matrix = mat_from_pos_quat(model.geom_pos[g], model.geom_quat[g])
        if geom_name not in scene.geometry:
            scene.add_geometry(
                geom,
                geom_name=geom_name,
                node_name=node,
                parent_node_name=body_node[int(model.geom_bodyid[g])],
                transform=matrix,
            )
        else:
            scene.graph.update(
                frame_to=node,
                frame_from=body_node[int(model.geom_bodyid[g])],
                matrix=matrix,
                geometry=geom_name,
            )
        nodes.append({"node": node, "body": body, "mesh": mesh_name, "material": mat_name})

    # ---- joints and sites, for the info panel and the idle animation
    joints = []
    for j in range(model.njnt):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, j)
        body = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, int(model.jnt_bodyid[j]))
        joints.append(
            {
                "name": name,
                "body": body,
                "node": body_node[int(model.jnt_bodyid[j])],
                "type": int(model.jnt_type[j]),
                "axis": [round(float(v), 5) for v in model.jnt_axis[j]],
                "range": [round(float(v), 4) for v in model.jnt_range[j]],
                "actuated": any(int(model.actuator_trnid[a][0]) == j for a in range(model.nu)),
            }
        )

    sites = []
    for s in range(model.nsite):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_SITE, s)
        sites.append(
            {
                "name": name,
                "body": mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, int(model.site_bodyid[s])),
                "world": [round(float(v), 5) for v in data.site_xpos[s]],
            }
        )

    bounds = scene.bounds
    meta = {
        "source": os.path.relpath(XML, "/workspace"),
        "nbody": int(model.nbody),
        "ngeom_visual": len(nodes),
        "nmesh": int(model.nmesh),
        "bounds": {
            "min": [round(float(v), 5) for v in bounds[0]],
            "max": [round(float(v), 5) for v in bounds[1]],
        },
        "bodies": bodies,
        "joints": joints,
        "sites": sites,
        "nodes": nodes,
    }

    scene.export(OUT_GLB, file_type="glb")
    with open(OUT_JSON, "w") as fh:
        json.dump(meta, fh, indent=2, ensure_ascii=False)

    size = os.path.getsize(OUT_GLB)
    print(f"wrote {OUT_GLB} ({size / 1e6:.2f} MB), {len(nodes)} geom nodes, {model.nmesh} meshes")
    print(f"wrote {OUT_JSON}")
    print("bounds", meta["bounds"])


if __name__ == "__main__":
    main()
