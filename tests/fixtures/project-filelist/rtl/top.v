module top (
    input  wire engine_data,
    output wire engine_out
);
    assign engine_out = engine_data;

    shared_child u_child (
        .engine_data(engine_data)
    );
endmodule
