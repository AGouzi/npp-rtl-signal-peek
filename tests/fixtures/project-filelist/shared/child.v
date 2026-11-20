module local_child (
    input  wire engine_data,
    output wire child_out
);
    assign child_out = ~engine_data;
endmodule
