"""Writes fake-demucs.onnx: a stand-in for HTDemucs with the same waveform
input and output shapes, for the browser test (the real model is ~170 MB).
Its "stems" are the mix scaled: drums 0.2, bass 0.3, other 0.1, vocals 0.4.

    python3 -m pip install onnx && python3 tests/fixtures/make-fake-demucs.py
"""
import os
import onnx
from onnx import TensorProto, helper

T = 343980
scale = helper.make_tensor("scale", TensorProto.FLOAT, [1, 4, 1, 1], [0.2, 0.3, 0.1, 0.4])
axes = helper.make_tensor("axes", TensorProto.INT64, [1], [1])
graph = helper.make_graph(
    [
        helper.make_node("Unsqueeze", ["mix", "axes"], ["mix4"]),
        helper.make_node("Mul", ["mix4", "scale"], ["time"]),
    ],
    "fake_demucs",
    [helper.make_tensor_value_info("mix", TensorProto.FLOAT, [1, 2, T])],
    [helper.make_tensor_value_info("time", TensorProto.FLOAT, [1, 4, 2, T])],
    initializer=[scale, axes],
)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, os.path.join(os.path.dirname(__file__), "fake-demucs.onnx"))
